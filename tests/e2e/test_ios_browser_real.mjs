import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import playwright from "../../web-ui/node_modules/playwright/index.js";

const { chromium } = playwright;
const deviceUdid = process.env.PONLET_IOS_UDID ?? "";
const cdpPort = Number(process.env.PONLET_IOS_CDP_PORT ?? "9236");
const webUrl = process.env.PONLET_TEST_WEB_URL ?? "https://ponlet.mat2uken.app/";
const transportOverride = process.env.PONLET_TEST_TRANSPORT;
const output = resolve(process.env.PONLET_TEST_OUTPUT ?? `${tmpdir()}/ponlet-ios-${Date.now()}`);
const appBundleId = "jp.yasagure.ponlet";
const knownTransportPaths = new Set(["direct-udp", "webrtc", "derp"]);

if (transportOverride && transportOverride !== "derp") {
  throw new Error(`unsupported PONLET_TEST_TRANSPORT: ${transportOverride}`);
}

// A page's URL alone cannot identify a device. Require a localhost CDP
// process explicitly bound to the requested UDID, then inspect its real page.
function verifyCdpDevice() {
  if (!/^[a-fA-F0-9-]+$/.test(deviceUdid)) throw new Error("PONLET_IOS_UDID is required");
  if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535)
    throw new Error("Invalid CDP port");
  const pids = execFileSync("lsof", ["-nP", "-t", `-iTCP:${cdpPort}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/);
  if (pids.length !== 1) throw new Error("Expected one dedicated CDP listener");
  const command = execFileSync("ps", ["-p", pids[0], "-o", "command="], { encoding: "utf8" });
  const args = command.trim().split(/\s+/);
  for (const [key, value] of [
    ["--udid", deviceUdid],
    ["--host", "127.0.0.1"],
    ["--port", String(cdpPort)],
  ]) {
    if (args[args.indexOf(key) + 1] !== value || !args.includes(key))
      throw new Error(`CDP process does not match ${key}`);
  }
  if (!args.includes("webinspector") || !args.includes("cdp"))
    throw new Error("Expected pymobiledevice3 CDP service");
  return { deviceUdid, cdpPort, serverPid: pids[0] };
}

function devicectl(...args) {
  return execFileSync("xcrun", ["devicectl", ...args], { encoding: "utf8" }).trim();
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

async function waitForIosSnapshot(page, predicate, description, timeout = 90_000) {
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

async function tapIosButton(page, locator) {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (!(await locator.isEnabled())) {
    if (Date.now() >= deadline) throw new Error("iOS button remained disabled");
    await page.waitForTimeout(100);
  }
  // The Web Inspector CDP bridge synthesizes mouse events using page
  // coordinates, which may point at a different row after scrolling. Invoke
  // the enabled DOM control directly. Physical touch is a separate UI test.
  await locator.evaluate((element) => {
    if (element.disabled) throw new Error("iOS button became disabled before click");
    element.click();
  });
}

function copyFromApp(source, destination) {
  const relative = source.match(
    /^\/(?:private\/)?var\/mobile\/Containers\/Data\/Application\/[A-Fa-f0-9-]+\/(.+)$/,
  )?.[1];
  if (!relative || relative.split("/").includes(".."))
    throw new Error(`Unexpected app file path: ${source}`);
  return devicectl(
    "device",
    "copy",
    "from",
    "--device",
    deviceUdid,
    "--source",
    relative,
    "--destination",
    destination,
    "--domain-type",
    "appDataContainer",
    "--domain-identifier",
    appBundleId,
    "--timeout",
    "120",
  );
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
  const endpoint = verifyCdpDevice();
  mkdirSync(output, { recursive: true });
  const startedAt = new Date().toISOString();
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
  let ios;
  try {
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const pages = cdp
      .contexts()
      .flatMap((value) => value.pages())
      .filter((value) => value.url() === "tauri://localhost");
    if (pages.length !== 1) throw new Error("One iOS Ponlet WebView must be open and unlocked");
    ios = pages[0];
    const identity = await ios.evaluate(() => ({
      url: location.href,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
    }));
    if (!/^iPhone$|^iPad$/.test(identity.platform) || !/iPhone|iPad/.test(identity.userAgent))
      throw new Error(`Unexpected device: ${JSON.stringify(identity)}`);
    writeFileSync(
      resolve(output, "identity.json"),
      JSON.stringify({ ...endpoint, ...identity, startedAt }, null, 2),
    );
    await host.goto(webUrl, { waitUntil: "networkidle" });
    const inviteSnapshot = await waitForSnapshot(
      host,
      (value) => typeof value.inviteUrl === "string" && value.inviteUrl.length > 0,
      "browser invite",
    );
    await host
      .getByRole("img", { name: /Invitation QR code|招待QRコード/ })
      .waitFor({ state: "visible", timeout: 30_000 });
    await ios.evaluate(() => {
      window.__ponletTestClicks = [];
      document.addEventListener("click", (event) => {
        window.__ponletTestClicks.push(
          event.target.closest("button")?.textContent ?? event.target.tagName,
        );
        if (window.__ponletTestClicks.length > 8) window.__ponletTestClicks.shift();
      });
    });
    const regeneratedInvites = [];
    for (let index = 0; index < 2; index++) {
      const previous = await ios.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("ponlet_snapshot"),
      );
      await tapIosButton(
        ios,
        ios.getByRole("button", { name: /^(Regenerate|再生成|Create invite|招待を作成)$/ }),
      );
      const regenerated = await waitForIosSnapshot(
        ios,
        (value) => value.inviteUrl && value.inviteUrl !== previous.inviteUrl,
        `iOS QR regeneration ${index + 1}`,
      );
      await ios.getByRole("img", { name: /Invitation QR code|招待QRコード/ }).waitFor();
      regeneratedInvites.push(sha256(regenerated.inviteUrl));
    }
    await ios.evaluate(
      (invite) => window.__TAURI_INTERNALS__.invoke("ponlet_join", { invite }),
      inviteSnapshot.inviteUrl,
    );
    const browserConnected = await waitForSnapshot(
      host,
      (value) => value.state === "connected",
      "browser connection",
    );
    const iosConnected = await waitForIosSnapshot(
      ios,
      (value) => value.state === "connected",
      "iOS connection",
    );

    const text = `Browser→iOS 実通信: 日本語 ✅ ${runId}`;
    await host.locator("textarea").fill(text);
    await host.getByRole("button", { name: /Send|送信/ }).click();
    await ios.getByText(`[Peer]: ${text}`).first().waitFor({ state: "visible" });

    const reverseText = `iOS→Browser 実通信: reply ↔ 日本語 ${runId}`;
    await ios.locator("textarea").fill(reverseText);
    await tapIosButton(ios, ios.getByRole("button", { name: /Send|送信/ }));
    await host.getByText(`[Peer]: ${reverseText}`).first().waitFor({ state: "visible" });

    const bytes = Buffer.from(Array.from({ length: 131_071 }, (_, index) => (index * 13) % 251));
    const expectedHash = sha256(bytes);
    const fileName = `browser-to-ios-${runId}-日本語.bin`;
    const [fileChooser] = await Promise.all([
      host.waitForEvent("filechooser"),
      host.getByRole("button", { name: /Choose file|ファイルを選択/ }).click(),
    ]);
    await fileChooser.setFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    const iosAfter = await waitForIosSnapshot(
      ios,
      (value) =>
        value.state === "connected" && value.received?.some((item) => item.name === fileName),
      "iOS file receive",
    );
    const received = iosAfter.received.find((item) => item.name === fileName);
    const copiedPath = resolve(output, "received.bin");
    copyFromApp(received.localPathOrHandle, copiedPath);
    const actualHash = sha256(readFileSync(copiedPath));
    if (actualHash !== expectedHash) {
      throw new Error(`iOS file hash mismatch: ${actualHash} != ${expectedHash}`);
    }
    const sameName = `ios12-${runId}-受信表示.txt`;
    const sameNameInputs = [
      Buffer.from("iPhone 12 Pro 保存・表示の確認\n公開Webからの日本語ファイルです。\n"),
      Buffer.from("iPhone 12 Pro 保存・表示の確認 2\n同名の最初の内容を保持します。\n"),
    ];
    const sameNameResults = [];
    for (const inputBytes of sameNameInputs) {
      const before = await ios.evaluate(() => window.__TAURI_INTERNALS__.invoke("ponlet_snapshot"));
      const pathsBefore = new Set(before.received.map((item) => item.localPathOrHandle));
      const [inputChooser] = await Promise.all([
        host.waitForEvent("filechooser"),
        host.getByRole("button", { name: /Choose file|ファイルを選択/ }).click(),
      ]);
      await inputChooser.setFiles({ name: sameName, mimeType: "text/plain", buffer: inputBytes });
      const after = await waitForIosSnapshot(
        ios,
        (value) =>
          value.state === "connected" &&
          value.received?.some((item) => !pathsBefore.has(item.localPathOrHandle)),
        `iOS same-name receive ${sameNameResults.length + 1}`,
      );
      const added = after.received.filter((item) => !pathsBefore.has(item.localPathOrHandle));
      if (added.length !== 1) throw new Error("Expected exactly one new received file");
      const item = added[0];
      if (!item.name.startsWith(`ios12-${runId}-受信表示`))
        throw new Error("Unexpected received file");
      sameNameResults.push({ ...item, expectedSha256: sha256(inputBytes) });
    }
    // Re-read both files after the collision, so overwriting the first file
    // cannot pass merely because its original contents were read earlier.
    for (const [index, item] of sameNameResults.entries()) {
      const path = resolve(output, `same-name-${index + 1}.txt`);
      copyFromApp(item.localPathOrHandle, path);
      item.sha256 = sha256(readFileSync(path));
      if (item.sha256 !== item.expectedSha256)
        throw new Error(`Same-name file ${index + 1} hash mismatch`);
    }
    if (
      new Set(sameNameResults.map((item) => item.localPathOrHandle)).size !== 2 ||
      new Set(sameNameResults.map((item) => item.name)).size !== 2
    )
      throw new Error("Same-name files were not preserved distinctly");
    // Exercise the native file source with the just-received test file. The
    // iOS document picker is a separate UI check; this uses its resulting
    // FileRequest and verifies the full reverse transfer and browser download.
    const reverseFileName = `ios-to-browser-${runId}-日本語.bin`;
    await ios.evaluate(
      (file) => window.__TAURI_INTERNALS__.invoke("ponlet_send_files", { files: [file] }),
      { name: reverseFileName, size: received.size, mime: null, path: received.localPathOrHandle },
    );
    await waitForSnapshot(
      host,
      (value) => value.received?.some((item) => item.name === reverseFileName),
      "Browser reverse file receive",
    );
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
    const iosFinal = await ios.evaluate(() => window.__TAURI_INTERNALS__.invoke("ponlet_snapshot"));
    assertTransport(browserFinal, "browser");
    assertTransport(iosFinal, "ios");

    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      webUrl,
      endpoint,
      identity,
      browser: { state: browserFinal.state, transport: browserFinal.transport },
      ios: { state: iosFinal.state, transport: iosFinal.transport },
      text,
      reverseText,
      regeneratedInvites,
      file: { ...received, sha256: actualHash },
      reverseFile: { name: reverseFileName, bytes: received.size, sha256: reverseHash },
      sameNameResults,
      nativePickerExercised: false,
    };
    writeFileSync(resolve(output, "result.json"), JSON.stringify(report, null, 2));
    await ios.screenshot({ path: resolve(output, "iphone-webview.png"), fullPage: true });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(
      "Browser diagnostics",
      await host
        .evaluate(async () => ({
          snapshot: await window.__ponletBackend?.snapshot?.(),
          draft: document.querySelector("textarea")?.value,
        }))
        .catch(String),
    );
    if (ios) {
      console.error(
        "iOS diagnostics",
        await ios
          .evaluate(async () => {
            const state = await window.__TAURI_INTERNALS__.invoke("ponlet_snapshot");
            return {
              state: state.state,
              error: state.error,
              transport: state.transport,
              receivedMessages: state.receivedMessages,
              clicks: window.__ponletTestClicks,
              draft: document.querySelector("textarea")?.value,
              syntheticMessages: [...document.querySelectorAll(".message-bubble")]
                .map((e) => e.textContent)
                .filter((text) => text.includes("実通信")),
              clientWidth: document.documentElement.clientWidth,
              innerWidth,
              innerHeight,
              visual: {
                offsetTop: visualViewport.offsetTop,
                height: visualViewport.height,
                scale: visualViewport.scale,
              },
            };
          })
          .catch(String),
      );
    }
    throw error;
  } finally {
    await cdp?.close();
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
