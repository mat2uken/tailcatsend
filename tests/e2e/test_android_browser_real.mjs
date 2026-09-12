import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import playwright from "../../web-ui/node_modules/playwright/index.js";

const { chromium } = playwright;
const root = resolve(new URL("../..", import.meta.url).pathname);
const dist = resolve(process.env.PONLET_TEST_DIST ?? resolve(root, "dist"));
const uiDist = resolve(process.env.PONLET_TEST_UI_DIST ?? resolve(root, "web-ui/dist/web"));
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

async function tapAndroidButton(page, locator) {
  await locator.waitFor({ state: "visible" });
  // Android WebView's IME pans the visual viewport independently of layout.
  // CDP clicks can hit a different row; send a real device tap at the visible
  // button's measured center. Ponlet's edge-to-edge WebView starts at (0, 0).
  let point;
  for (let attempt = 0; attempt < 30; attempt++) {
    point = await locator.evaluate((element) => {
      if (element.disabled) return null;
      const rect = element.getBoundingClientRect();
      const view = visualViewport;
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      if (y < view.offsetTop || y >= view.offsetTop + view.height) {
        scrollBy(0, y - view.offsetTop - view.height / 2);
        return null;
      }
      if (!element.contains(document.elementFromPoint(x, y))) return null;
      return {
        x: Math.round((x - view.offsetLeft) * view.scale * devicePixelRatio),
        y: Math.round((y - view.offsetTop) * view.scale * devicePixelRatio),
      };
    });
    if (point) break;
    await page.waitForTimeout(100);
  }
  if (!point) throw new Error("Android button is not available in the visible viewport");
  adb("shell", "input", "tap", String(point.x), String(point.y));
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
  const runId = Date.now().toString();
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
  let android;
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
    android = cdp
      .contexts()
      .flatMap((value) => value.pages())
      .find((value) => value.url().startsWith("http://tauri.localhost"));
    if (!android) {
      throw new Error("Android WebView page not found");
    }
    await android.evaluate(() => {
      window.__ponletTestClicks = [];
      document.addEventListener("click", (event) => {
        window.__ponletTestClicks.push(event.target.closest("button")?.textContent ?? event.target.tagName);
        if (window.__ponletTestClicks.length > 8) window.__ponletTestClicks.shift();
      });
    });
    const regeneratedInvites = [];
    for (let index = 0; index < 2; index++) {
      const previous = await android.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("ponlet_snapshot"),
      );
      await tapAndroidButton(android,
        android.getByRole("button", { name: /^(Regenerate|再生成|Create invite|招待を作成)$/ }));
      const regenerated = await waitForAndroidSnapshot(
        android,
        (value) => value.inviteUrl && value.inviteUrl !== previous.inviteUrl,
        `Android QR regeneration ${index + 1}`,
      );
      await android.getByRole("img", { name: /Invitation QR code|招待QRコード/ }).waitFor();
      regeneratedInvites.push(sha256(regenerated.inviteUrl));
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

    const text = `Browser→Android 実通信: 日本語 ✅ ${runId}`;
    await host.locator("textarea").fill(text);
    await host.getByRole("button", { name: /Send|送信/ }).click();
    await android.getByText(`[Peer]: ${text}`).first().waitFor({ state: "visible" });

    const reverseText = `Android→Browser 実通信: reply ↔ 日本語 ${runId}`;
    await android.locator("textarea").fill(reverseText);
    await tapAndroidButton(android, android.getByRole("button", { name: /Send|送信/ }));
    await host.getByText(`[Peer]: ${reverseText}`).first().waitFor({ state: "visible" });

    const bytes = Buffer.from(Array.from({ length: 131_071 }, (_, index) => (index * 13) % 251));
    const expectedHash = sha256(bytes);
    const fileName = `browser-to-android-${runId}-日本語.bin`;
    const [fileChooser] = await Promise.all([
      host.waitForEvent("filechooser"),
      host.getByRole("button", { name: /Choose file|ファイルを選択/ }).click(),
    ]);
    await fileChooser.setFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    const androidAfter = await waitForAndroidSnapshot(
      android,
      (value) =>
        value.state === "connected" &&
        value.received?.some((item) => item.name === fileName),
      "Android file receive",
    );
    const received = androidAfter.received.find(
      (item) => item.name === fileName,
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
    // Exercise the native file source with the just-received test file. The
    // Android document picker is a separate UI check; this uses its resulting
    // FileRequest and verifies the full reverse transfer and browser download.
    const reverseFileName = `android-to-browser-${runId}-日本語.bin`;
    await android.evaluate(
      (file) => window.__TAURI_INTERNALS__.invoke("ponlet_send_files", { files: [file] }),
      { name: reverseFileName, size: received.size, mime: null, path: received.localPathOrHandle },
    );
    await waitForSnapshot(host,
      (value) => value.received?.some((item) => item.name === reverseFileName),
      "Browser reverse file receive");
    const [download] = await Promise.all([
      host.waitForEvent("download"),
      host.getByRole("button", { name: /^(Open|開く)$/ }).click(),
    ]);
    const reversePath = await download.path();
    if (!reversePath) throw new Error("Reverse file download path was not created");
    const reverseHash = sha256(readFileSync(reversePath));
    if (reverseHash !== expectedHash) {
      throw new Error(`Browser reverse file hash mismatch: ${reverseHash} != ${expectedHash}`);
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
          regeneratedInvites,
          file: {
            name: received.name,
            bytes: received.size,
            sha256: actualHash,
          },
          reverseFile: { name: reverseFileName, bytes: received.size, sha256: reverseHash },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error("Browser diagnostics", await host.evaluate(async () => ({
      snapshot: await window.__ponletBackend?.snapshot?.(),
      draft: document.querySelector("textarea")?.value,
    })).catch(String));
    if (android) {
      console.error("Android diagnostics", await android.evaluate(async () => {
        const state = await window.__TAURI_INTERNALS__.invoke("ponlet_snapshot");
        return {
          state: state.state, error: state.error, transport: state.transport,
          receivedMessages: state.receivedMessages,
          clicks: window.__ponletTestClicks,
          draft: document.querySelector("textarea")?.value,
          syntheticMessages: [...document.querySelectorAll(".message-bubble")].map(e => e.textContent).filter(text => text.includes("実通信")),
          clientWidth: document.documentElement.clientWidth, innerWidth, innerHeight,
          visual: { offsetTop: visualViewport.offsetTop, height: visualViewport.height, scale: visualViewport.scale },
        };
      }).catch(String));
    }
    throw error;
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
