import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import playwright from "../../web-ui/node_modules/playwright/index.js";

const { chromium } = playwright;
const root = resolve(new URL("../..", import.meta.url).pathname);
const dist = resolve(root, "dist");
const uiDist = resolve(root, "web-ui/dist/web");
const serial = process.env.PONLET_ANDROID_SERIAL ?? "";
const cdpPort = Number(process.env.PONLET_ANDROID_CDP_PORT ?? "9223");
const transportOverride = process.env.PONLET_TEST_TRANSPORT;
const knownTransportPaths = new Set(["direct-udp", "webrtc", "derp"]);

if (transportOverride && transportOverride !== "derp") {
  throw new Error(`unsupported PONLET_TEST_TRANSPORT: ${transportOverride}`);
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

function requiredFile(path) {
  if (!existsSync(path)) {
    throw new Error(`missing generated artifact: ${path}`);
  }
}

function serveStatic() {
  const server = createServer((request, response) => {
    try {
      const requestPath = decodeURIComponent((request.url ?? "/").split("?", 1)[0]);
      const relative = requestPath === "/" ? "/index.html" : requestPath;
      const uiFile = resolve(uiDist, `.${relative}`);
      const distFile = resolve(dist, `.${relative}`);
      const file = existsSync(uiFile) ? uiFile : distFile;
      if (!(file.startsWith(`${dist}${sep}`) || file.startsWith(`${uiDist}${sep}`))) {
        response.writeHead(400).end("invalid path");
        return;
      }
      if (!existsSync(file)) {
        response.writeHead(404).end("not found");
        return;
      }
      const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(400).end(String(error));
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveServer({ server, port: server.address().port });
    });
  });
}

function adb(...args) {
  return execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" }).trim();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function snapshot(page) {
  return page.evaluate(() => window.__ponletBackend?.snapshot?.());
}

async function waitForSnapshot(page, predicate, description, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await snapshot(page);
    if (last && predicate(last)) {
      return last;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`${description}: timed out; last snapshot=${JSON.stringify(last)}`);
}

async function waitForAndroidSnapshot(page, predicate, description, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.__TAURI_INTERNALS__?.invoke("ponlet_snapshot"));
    if (last && predicate(last)) {
      return last;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`${description}: timed out; last snapshot=${JSON.stringify(last)}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertTransport(snapshotValue, label) {
  if (!knownTransportPaths.has(snapshotValue.transport)) {
    throw new Error(`${label} reported an unknown transport: ${snapshotValue.transport}`);
  }
  if (transportOverride === "derp" && snapshotValue.transport !== "derp") {
    throw new Error(`${label} did not use DERP: ${snapshotValue.transport}`);
  }
}

async function main() {
  if (!serial) {
    throw new Error("PONLET_ANDROID_SERIAL is required");
  }
  requiredFile(resolve(dist, "assets/tailcat.wasm.gz"));
  requiredFile(resolve(dist, "assets/wasm_exec.js"));
  requiredFile(resolve(dist, "wasm/tailsend_web_bg.wasm"));
  requiredFile(resolve(uiDist, "index.html"));
  requiredFile(resolve(uiDist, "assets/index.js"));

  const pid = adb("shell", "pidof", "jp.yasagure.ponlet");
  if (!pid) {
    throw new Error("Ponlet Android process is not running");
  }
  adb("forward", `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`);

  const { server, port } = await serveStatic();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  if (transportOverride === "derp") {
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, "RTCPeerConnection", {
        configurable: true,
        value: undefined,
      });
    });
  }
  const host = await context.newPage();
  let cdp;
  try {
    const pageUrl = transportOverride
      ? `http://127.0.0.1:${port}/?transport=${encodeURIComponent(transportOverride)}`
      : `http://127.0.0.1:${port}/`;
    await host.goto(pageUrl, { waitUntil: "networkidle" });
    const inviteSnapshot = await waitForSnapshot(
      host,
      (value) => typeof value.inviteUrl === "string" && value.inviteUrl.length > 0,
      "browser invite",
    );
    await host
      .getByRole("img", { name: /Invitation QR code|招待QRコード/ })
      .waitFor({ state: "visible", timeout: 30_000 });

    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const android = cdp
      .contexts()
      .flatMap((value) => value.pages())
      .find((value) => value.url().startsWith("http://tauri.localhost"));
    if (!android) {
      throw new Error("Android WebView page not found");
    }
    await android.evaluate(
      (invite) => window.__TAURI_INTERNALS__.invoke("ponlet_join", { invite }),
      inviteSnapshot.inviteUrl,
    );
    const browserConnected = await waitForSnapshot(
      host,
      (value) => value.state === "connected",
      "browser connection",
    );
    const androidConnected = await waitForAndroidSnapshot(
      android,
      (value) => value.state === "connected",
      "Android connection",
    );

    const text = "Browser→Android 実通信: 日本語 ✅";
    await host.locator("textarea").fill(text);
    await host.getByRole("button", { name: /Send|送信/ }).click({ force: true });
    await android.getByText(`[Peer]: ${text}`).first().waitFor({ state: "visible" });

    const reverseText = "Android→Browser 実通信: reply ↔ 日本語";
    await android.locator("textarea").fill(reverseText);
    await android.getByRole("button", { name: /Send|送信/ }).click({ force: true });
    await host.getByText(`[Peer]: ${reverseText}`).first().waitFor({ state: "visible" });

    const bytes = Buffer.from(Array.from({ length: 131_071 }, (_, index) => (index * 13) % 251));
    const expectedHash = sha256(bytes);
    await host.locator('input[type="file"]').setInputFiles({
      name: "browser-to-android-日本語.bin",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    const androidAfter = await waitForAndroidSnapshot(
      android,
      (value) =>
        value.state === "connected" &&
        value.received?.some((item) => item.name === "browser-to-android-日本語.bin"),
      "Android file receive",
    );
    const received = androidAfter.received.find(
      (item) => item.name === "browser-to-android-日本語.bin",
    );
    const relativePath = received.localPathOrHandle.replace(
      /^\/data\/user\/0\/jp\.yasagure\.ponlet\//,
      "",
    );
    const hashOutput = adb(
      "shell",
      `run-as jp.yasagure.ponlet sha256sum -- ${shellQuote(relativePath)}`,
    );
    const actualHash = hashOutput.split(/\s+/, 1)[0];
    if (actualHash !== expectedHash) {
      throw new Error(`Android file hash mismatch: ${actualHash} != ${expectedHash}`);
    }
    const browserFinal = await snapshot(host);
    assertTransport(browserFinal, "browser");
    assertTransport(androidAfter, "android");

    console.log(
      JSON.stringify(
        {
          browser: { state: browserFinal.state, transport: browserFinal.transport },
          android: { state: androidAfter.state, transport: androidAfter.transport },
          text,
          reverseText,
          file: {
            name: received.name,
            bytes: received.size,
            sha256: actualHash,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await cdp?.close();
    await context.close();
    await browser.close();
    await new Promise((resolveServer) => server.close(resolveServer));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
