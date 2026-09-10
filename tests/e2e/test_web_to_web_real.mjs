import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import playwright from "../../web-ui/node_modules/playwright/index.js";

const { chromium } = playwright;

const root = resolve(new URL("../..", import.meta.url).pathname);
const dist = resolve(root, "dist");
const uiDist = resolve(root, "web-ui/dist/web");
const transportOverride = process.env.PONLET_TEST_TRANSPORT;
const knownTransportPaths = new Set(["direct-udp", "webrtc", "derp"]);

if (transportOverride && !["webrtc", "derp"].includes(transportOverride)) {
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

async function waitForSnapshot(page, predicate, description) {
  const deadline = Date.now() + 60_000;
  let last;
  while (Date.now() < deadline) {
    last = await snapshot(page);
    if (last && predicate(last)) {
      return last;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`${description}: timed out; last snapshot=${JSON.stringify(last)}`);
}

async function snapshot(page) {
  return page.evaluate(() => window.__ponletBackend?.snapshot());
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
  const required = [
    "dist/assets/tailcat.wasm.gz",
    "dist/assets/wasm_exec.js",
    "dist/wasm/tailsend_web_bg.wasm",
  ];
  for (const file of required) {
    if (!existsSync(resolve(root, file))) {
      throw new Error(`missing generated browser artifact: ${file}`);
    }
  }

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
  const joiner = await context.newPage();
  const base = `http://127.0.0.1:${port}`;
  const pageUrl = transportOverride
    ? `${base}/?transport=${encodeURIComponent(transportOverride)}`
    : `${base}/`;

  try {
    await host.goto(pageUrl, { waitUntil: "networkidle" });
    await waitForSnapshot(host, (value) => value.state === "ready", "host backend startup");
    await host.getByRole("button", { name: /Create invite|招待を作成/ }).click();
    const inviteSnapshot = await waitForSnapshot(
      host,
      (value) => typeof value.inviteUrl === "string" && value.inviteUrl.length > 0,
      "invite creation",
    );
    const invite = new URL(inviteSnapshot.inviteUrl);
    const joinUrl = transportOverride
      ? `${base}/?transport=${encodeURIComponent(transportOverride)}#${invite.hash.slice(1)}`
      : `${base}/#${invite.hash.slice(1)}`;
    await joiner.goto(joinUrl, { waitUntil: "networkidle" });

    await waitForSnapshot(host, (value) => value.state === "connected", "host connection");
    await waitForSnapshot(joiner, (value) => value.state === "connected", "joiner connection");

    const text = "Web UI 実通信の確認: 日本語と絵文字 ✅";
    await host.locator("textarea").fill(text);
    await host.getByRole("button", { name: /Send|送信/ }).click();
    await joiner.getByText(`[Peer]: ${text}`).waitFor({ state: "visible", timeout: 30_000 });

    const bytes = Buffer.from(Array.from({ length: 131_089 }, (_, index) => index % 251));
    const expectedHash = sha256(bytes);
    await host.locator('input[type="file"]').setInputFiles({
      name: "実通信-日本語.bin",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    await waitForSnapshot(
      joiner,
      (value) => Array.isArray(value.received) && value.received.length === 1,
      "file receive",
    );
    const received = await snapshot(joiner);
    const downloadPromise = joiner.waitForEvent("download");
    await joiner.getByRole("button", { name: /Open|開く/ }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error("download path was not created");
    const actualBytes = readFileSync(downloadPath);
    const actualHash = sha256(actualBytes);
    if (actualHash !== expectedHash) {
      throw new Error(`received hash mismatch: ${actualHash} != ${expectedHash}`);
    }

    const reverseText = "Web UI 双方向確認: reply ↔ 日本語";
    await joiner.locator("textarea").fill(reverseText);
    await joiner.getByRole("button", { name: /Send|送信/ }).click();
    await host.getByText(`[Peer]: ${reverseText}`).waitFor({ state: "visible", timeout: 30_000 });

    const reverseBytes = Buffer.from(
      Array.from({ length: 98_321 }, (_, index) => (index * 7) % 251),
    );
    const reverseHash = sha256(reverseBytes);
    await joiner.locator('input[type="file"]').setInputFiles({
      name: "reply-日本語.dat",
      mimeType: "application/octet-stream",
      buffer: reverseBytes,
    });
    await waitForSnapshot(
      host,
      (value) => Array.isArray(value.received) && value.received.length === 1,
      "reverse file receive",
    );
    const reverseReceived = await snapshot(host);
    const reverseDownloadPromise = host.waitForEvent("download");
    await host.getByRole("button", { name: /Open|開く/ }).click();
    const reverseDownload = await reverseDownloadPromise;
    const reverseDownloadPath = await reverseDownload.path();
    if (!reverseDownloadPath) throw new Error("reverse download path was not created");
    const reverseActualBytes = readFileSync(reverseDownloadPath);
    const reverseActualHash = sha256(reverseActualBytes);
    if (reverseActualHash !== reverseHash) {
      throw new Error(`reverse received hash mismatch: ${reverseActualHash} != ${reverseHash}`);
    }

    const hostFinal = await snapshot(host);
    const joinerFinal = await snapshot(joiner);
    assertTransport(hostFinal, "host");
    assertTransport(joinerFinal, "joiner");
    console.log(
      JSON.stringify(
        {
          host: { state: hostFinal.state, transport: hostFinal.transport },
          joiner: { state: joinerFinal.state, transport: joinerFinal.transport },
          text,
          reverseText,
          file: {
            name: received.received[0].name,
            bytes: actualBytes.length,
            sha256: actualHash,
          },
          reverseFile: {
            name: reverseReceived.received[0].name,
            bytes: reverseActualBytes.length,
            sha256: reverseActualHash,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolveServer) => server.close(resolveServer));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
