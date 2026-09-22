import { sha256, assertTransport, waitFor } from "./test-support.mjs";
import { serveStatic } from "./static-server.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import playwright from "../../web-ui/node_modules/playwright/index.js";

const waitForSnapshot = (page, predicate, description) => waitFor(() => snapshot(page), predicate, description, 60_000, 100);
const browserName = process.env.PONLET_TEST_BROWSER ?? "chromium";
const persistent = process.env.PONLET_TEST_PERSISTENT === "1";
if (!["chromium", "firefox", "webkit"].includes(browserName)) {
  throw new Error(`unsupported PONLET_TEST_BROWSER: ${browserName}`);
}

const root = resolve(new URL("../..", import.meta.url).pathname);
const dist = resolve(process.env.PONLET_TEST_DIST ?? resolve(root, "dist"));
const uiDist = resolve(process.env.PONLET_TEST_UI_DIST ?? resolve(root, "web-ui/dist/web"));
const transportOverride = process.env.PONLET_TEST_TRANSPORT;

if (transportOverride && !["webrtc", "derp"].includes(transportOverride)) {
  throw new Error(`unsupported PONLET_TEST_TRANSPORT: ${transportOverride}`);
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

async function downloadReceived(page, index = 0) {
  await selectTab(page, /Transfer|転送/);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.locator(".received-item").nth(index).getByRole("button", { name: /Open|開く/ }).click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("received download path was not created");
  return readFileSync(path);
}

async function selectTab(page, name) {
  await page.getByRole("tab", { name }).first().click();
}

async function sendMessage(page, text) {
  await selectTab(page, /Messages|メッセージ/);
  await page.locator("textarea").fill(text);
  await page.getByRole("button", { name: /Send|送信/ }).click();
}

async function expectMessage(page, direction, text) {
  await selectTab(page, /Messages|メッセージ/);
  await page
    .locator(`.message-bubble.${direction}`)
    .filter({ hasText: text })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
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

  const { server, port } = await serveStatic({ dist, uiDist });
  const profile = persistent ? mkdtempSync(resolve(tmpdir(), "ponlet-browser-test-")) : null;
  const browser = persistent ? null : await playwright[browserName].launch({ headless: true });
  const context = persistent
    ? await playwright[browserName].launchPersistentContext(profile, { headless: true, acceptDownloads: true })
    : await browser.newContext({ acceptDownloads: true });
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
  const diagnostics = [];
  for (const [name, page] of [["host", host], ["joiner", joiner]]) {
    const remember = (message) => {
      diagnostics.push(`${name}: ${message}`);
      if (diagnostics.length > 80) diagnostics.shift();
    };
    page.on("console", (message) => remember(message.text()));
    page.on("pageerror", (error) => remember(String(error)));
  }
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
      console.log(`Regenerating invitation ${attempt + 1}/2`);
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

    // A phone browser can restore or reload the invitation page after the
    // first connection. The same invitation must complete the handshake again
    // and replace the previous peer instead of leaving the visible page stuck
    // before the connection.
    const rejoiner = await context.newPage();
    await rejoiner.goto(joinUrl, { waitUntil: "domcontentloaded" });
    await waitForSnapshot(rejoiner, (value) => value.state === "connected", "rejoin connection");
    await waitForSnapshot(host, (value) => value.state === "connected", "host after rejoin");
    const rejoinText = "再接続の確認: 日本語 ✅";
    await sendMessage(host, rejoinText);
    await expectMessage(rejoiner, "incoming", rejoinText);
    await rejoiner.close();
    // Return the original page to the peer role for the remaining checks.
    await joiner.goto("about:blank");
    await joiner.goto(joinUrl, { waitUntil: "domcontentloaded" });
    await waitForSnapshot(joiner, (value) => value.state === "connected", "joiner reconnected");

    const text = "Web UI 実通信の確認: 日本語と絵文字 ✅";
    await sendMessage(host, text);
    await expectMessage(joiner, "incoming", text);

    const bytes = Buffer.from(Array.from({ length: 131_089 }, (_, index) => index % 251));
    const expectedHash = sha256(bytes);
    await selectTab(host, /Transfer|転送/);
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
    const actualBytes = await downloadReceived(joiner);
    const actualHash = sha256(actualBytes);
    if (actualHash !== expectedHash) {
      throw new Error(`received hash mismatch: ${actualHash} != ${expectedHash}`);
    }

    await expectMessage(host, "outgoing", text);
    const reverseText = "Web UI 双方向確認: reply ↔ 日本語";
    await sendMessage(joiner, reverseText);
    await expectMessage(host, "incoming", reverseText);

    const reverseBytes = Buffer.from(
      Array.from({ length: 98_321 }, (_, index) => (index * 7) % 251),
    );
    const reverseHash = sha256(reverseBytes);
    await selectTab(joiner, /Transfer|転送/);
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
    const reverseActualBytes = await downloadReceived(host);
    const reverseActualHash = sha256(reverseActualBytes);
    if (reverseActualHash !== reverseHash) {
      throw new Error(`reverse received hash mismatch: ${reverseActualHash} != ${reverseHash}`);
    }

    // OPFS move replaces an existing destination by default. Receiving a
    // second file with the same name must preserve both downloaded contents.
    const duplicateBytes = Buffer.from("同じ名前でも前のファイルを保持する ✅");
    await selectTab(host, /Transfer|転送/);
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
    for (let index = 0; index < sameNameFiles.length; index++) {
      savedHashes.push(sha256(await downloadReceived(joiner, index)));
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
    await selectTab(host, /Transfer|転送/);
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
          persistent,
          regressions: { invalidInvitationPreserved: true, repeatedInvitation: true, repeatedJoinReplacesPeer: true, outgoingHistory: true, sameNameFilesPreserved: true, batchCancelled: true, waitingAfterDisconnect: true },
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
  } catch (error) {
    console.error(diagnostics.join("\n"));
    throw error;
  } finally {
    clearTimeout(deadline);
    await context.close();
    await browser?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
    await new Promise((resolveServer) => server.close(resolveServer));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
