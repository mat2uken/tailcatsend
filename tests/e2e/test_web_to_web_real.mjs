import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import playwright from "../../web-ui/node_modules/playwright/index.js";

const browserName = process.env.PONLET_TEST_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(browserName)) {
  throw new Error(`unsupported PONLET_TEST_BROWSER: ${browserName}`);
}

const root = resolve(new URL("../..", import.meta.url).pathname);
const dist = resolve(process.env.PONLET_TEST_DIST ?? resolve(root, "dist"));
const uiDist = resolve(process.env.PONLET_TEST_UI_DIST ?? resolve(root, "web-ui/dist/web"));
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
  let timer;
  try {
    return await Promise.race([
      page.evaluate(() => window.__ponletBackend?.snapshot()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Backend snapshot did not respond within 10 seconds")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    if (!existsSync(resolve(dist, file.replace(/^dist\//, "")))) {
      throw new Error(`missing generated browser artifact: ${file}`);
    }
  }

  const { server, port } = await serveStatic();
  const browser = await playwright[browserName].launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const deadline = setTimeout(() => {
    console.error("Real browser transfer test exceeded five minutes");
    void context.close();
  }, 300_000);
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
    await host.goto(pageUrl, { waitUntil: "domcontentloaded" });
    let inviteSnapshot = await waitForSnapshot(
      host,
      (value) => typeof value.inviteUrl === "string" && value.inviteUrl.length > 0,
      "invite creation",
    );
    await host
      .getByRole("img", { name: /Invitation QR code|招待QRコード/ })
      .waitFor({ state: "visible", timeout: 30_000 });
    // Invalid input must leave an existing invitation usable.
    await host.evaluate(async () => {
      try { await window.__ponletBackend.join("invalid invitation"); } catch { return; }
      throw new Error("Invalid invitation was accepted");
    });
    if ((await snapshot(host)).inviteUrl !== inviteSnapshot.inviteUrl) {
      throw new Error("Invalid input destroyed the waiting invitation");
    }
    // Replacing the listener must not let a late close/handshake error win.
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = inviteSnapshot.inviteUrl;
      await host.getByRole("button", { name: /Create invite|Regenerate|招待を作成|再生成/, exact: true }).click();
      inviteSnapshot = await waitForSnapshot(host, (value) => value.inviteUrl && value.inviteUrl !== previous, "replace invitation");
    }
    await host.waitForTimeout(300);
    if ((await snapshot(host)).state !== "awaiting-peer") throw new Error("Stale handshake replaced invitation state");
    const invite = new URL(inviteSnapshot.inviteUrl);
    const joinUrl = transportOverride
      ? `${base}/?transport=${encodeURIComponent(transportOverride)}#${invite.hash.slice(1)}`
      : `${base}/#${invite.hash.slice(1)}`;
    await joiner.goto(joinUrl, { waitUntil: "domcontentloaded" });

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

    await host.getByText(`[Me]: ${text}`).waitFor({ state: "visible", timeout: 30_000 });
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

    // OPFS move replaces an existing destination by default. Receiving a
    // second file with the same name must preserve both downloaded contents.
    const duplicateBytes = Buffer.from("同じ名前でも前のファイルを保持する ✅");
    await host.locator('input[type="file"]').setInputFiles({
      name: "実通信-日本語.bin",
      mimeType: "application/octet-stream",
      buffer: duplicateBytes,
    });
    await waitForSnapshot(joiner, (value) => value.received.length === 2, "same-name file receive");
    const duplicateReceived = await snapshot(joiner);
    const sameNameFiles = duplicateReceived.received;
    if (new Set(sameNameFiles.map((item) => item.localPathOrHandle)).size !== 2) {
      throw new Error("Same-name receives share a storage handle");
    }
    const savedHashes = [];
    for (const item of sameNameFiles) {
      const pending = joiner.waitForEvent("download");
      await joiner.evaluate((receivedItem) => window.__ponletBackend.openReceivedItem(receivedItem), item);
      const saved = await pending;
      const path = await saved.path();
      if (!path) throw new Error("same-name download path was not created");
      savedHashes.push(sha256(readFileSync(path)));
    }
    if (!savedHashes.includes(expectedHash) || !savedHashes.includes(sha256(duplicateBytes))) {
      throw new Error(`Same-name file contents were replaced: ${JSON.stringify(savedHashes)}`);
    }

    const hostFinal = await snapshot(host);
    const joinerFinal = await snapshot(joiner);
    assertTransport(hostFinal, "host");
    assertTransport(joinerFinal, "joiner");
    // Cancel a batch while its first file is active. The second file must
    // never be started, even though cancellation itself is not a send error.
    await host.locator('input[type="file"]').setInputFiles([
      { name: "cancel-first.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(16 * 1024 * 1024, 7) },
      { name: "must-not-send-after-cancel.bin", mimeType: "application/octet-stream", buffer: Buffer.from("must not arrive") },
    ]);
    await waitForSnapshot(host, (value) => value.transfer?.name === "cancel-first.bin", "cancellable batch starts");
    await host.getByRole("button", { name: /^Cancel$|^キャンセル$/ }).click();
    await waitForSnapshot(host, (value) => value.state === "connected", "batch cancelled");
    await host.waitForTimeout(800);
    if ((await snapshot(joiner)).received.some((item) => item.name === "must-not-send-after-cancel.bin")) {
      throw new Error("The second file was sent after cancellation");
    }
    await host.getByRole("button", { name: /^Disconnect$|^切断$/ }).click();
    await waitForSnapshot(host, (value) => value.state === "awaiting-peer", "waiting after disconnect");
    await host.waitForTimeout(300);
    if ((await snapshot(host)).state !== "awaiting-peer") throw new Error("Late transfer completion resurrected a disconnected peer");
    console.log(
      JSON.stringify(
        {
          browser: browserName,
          regressions: { invalidInvitationPreserved: true, repeatedInvitation: true, outgoingHistory: true, sameNameFilesPreserved: true, batchCancelled: true, waitingAfterDisconnect: true },
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
    clearTimeout(deadline);
    await context.close();
    await browser.close();
    await new Promise((resolveServer) => server.close(resolveServer));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
