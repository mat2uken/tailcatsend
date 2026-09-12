import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import playwright from "../../web-ui/node_modules/playwright/index.js";

const { chromium } = playwright;
const root = resolve(new URL("../..", import.meta.url).pathname);
const dist = resolve(process.env.PONLET_TEST_DIST ?? resolve(root, "dist"));
const uiDist = resolve(process.env.PONLET_TEST_UI_DIST ?? resolve(root, "web-ui/dist/web"));
const serial = process.env.PONLET_ANDROID_SERIAL ?? "";
const cdpPort = Number(process.env.PONLET_ANDROID_CDP_PORT ?? "9223");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type":
          contentTypes[file.slice(file.lastIndexOf(".")).toLowerCase()] ??
          "application/octet-stream",
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

async function snapshot(page) {
  return page.evaluate(() => window.__ponletBackend?.snapshot?.());
}

async function androidSnapshot(page) {
  return page.evaluate(() => window.__TAURI_INTERNALS__?.invoke("ponlet_snapshot"));
}

async function waitFor(read, predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last && predicate(last)) {
      return last;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (!serial) {
  throw new Error("PONLET_ANDROID_SERIAL is required");
}

for (const file of [
  resolve(dist, "assets/tailcat.wasm.gz"),
  resolve(dist, "assets/wasm_exec.js"),
  resolve(dist, "wasm/tailsend_web_bg.wasm"),
  resolve(uiDist, "index.html"),
  resolve(uiDist, "assets/index.js"),
]) {
  if (!existsSync(file)) {
    throw new Error(`missing generated artifact: ${file}`);
  }
}

const { server, port } = await serveStatic();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const host = await context.newPage();
let cdp;
try {
  await host.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  const invitation = await waitFor(
    () => snapshot(host),
    (value) => typeof value.inviteUrl === "string" && value.inviteUrl.length > 0,
    "invite",
  );
  await host
    .getByRole("img", { name: /Invitation QR code|招待QRコード/ })
    .waitFor({ state: "visible", timeout: 30_000 });

  const pid = adb("shell", "pidof", "jp.yasagure.ponlet");
  if (!pid) {
    throw new Error("Ponlet Android process is not running");
  }
  adb("forward", `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`);
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
    invitation.inviteUrl,
  );
  await waitFor(
    () => snapshot(host),
    (value) => value.state === "connected",
    "browser connected",
  );
  await waitFor(
    () => androidSnapshot(android),
    (value) => value.state === "connected",
    "Android connected",
  );

  const runTag = String(Date.now());
  const cancelledName = `cancel-then-retransfer-${runTag}.bin`;
  const cancelledSize = 64 * 1024 * 1024;
  await host.evaluate(
    ({ name, size }) => {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (index * 17) % 251;
      }
      const file = new File([bytes], name, { type: "application/octet-stream" });
      globalThis.__cancelTransferPromise = globalThis.__ponletBackend
        .sendFiles([file])
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: String(error) }));
    },
    { name: cancelledName, size: cancelledSize },
  );
  const active = await waitFor(
    () => snapshot(host),
    (value) =>
      value.state === "transferring" &&
      value.transfer?.id &&
      value.transfer.total === cancelledSize,
    "cancel transfer start",
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const progressed = await snapshot(host);
  const cancelResult = await host.evaluate(async (id) => {
    await window.__ponletBackend.cancelTransfer(id);
    return await globalThis.__cancelTransferPromise;
  }, active.transfer.id);
  await waitFor(
    () => snapshot(host),
    (value) => value.state === "connected" && value.transfer == null,
    "sender after cancellation",
  );
  const androidAfterCancel = await waitFor(
    () => androidSnapshot(android),
    (value) =>
      value.state === "connected" &&
      value.transfer == null &&
      !value.received?.some((item) => item.name === cancelledName),
    "receiver after cancellation",
  );
  const leftovers = adb(
    "shell",
    `run-as jp.yasagure.ponlet sh -c 'find received -maxdepth 1 -type f -name ".${cancelledName}*" -print'`,
  );
  if (leftovers) {
    throw new Error(`cancelled temporary files remain: ${leftovers}`);
  }

  const retransmitName = `cancel-retransfer-${runTag}-日本語.bin`;
  const retransmitBytes = Buffer.from(
    Array.from({ length: 131_071 }, (_, index) => (index * 29) % 251),
  );
  const expectedHash = sha256(retransmitBytes);
  await host.locator('input[type="file"]').setInputFiles({
    name: retransmitName,
    mimeType: "application/octet-stream",
    buffer: retransmitBytes,
  });
  const retransmitActive = await waitFor(
    () => snapshot(host),
    (value) => value.state === "transferring" && value.transfer?.total === retransmitBytes.length,
    "retransfer start",
  );
  const androidAfterRetransmit = await waitFor(
    () => androidSnapshot(android),
    (value) =>
      value.state === "connected" && value.received?.some((item) => item.name === retransmitName),
    "retransfer receive",
  );
  const received = androidAfterRetransmit.received.find((item) => item.name === retransmitName);
  const relativePath = received.localPathOrHandle.replace(
    /^\/data\/user\/0\/jp\.yasagure\.ponlet\//,
    "",
  );
  const actualHash = adb(
    "shell",
    `run-as jp.yasagure.ponlet sha256sum -- '${relativePath.replaceAll("'", String.raw`'\''`)}'`,
  ).split(/\s+/, 1)[0];
  if (actualHash !== expectedHash) {
    throw new Error(`retransfer hash mismatch: ${actualHash} != ${expectedHash}`);
  }
  const hostFinal = await waitFor(
    () => snapshot(host),
    (value) => value.state === "connected" && value.transfer == null,
    "sender after retransfer",
  );
  console.log(
    JSON.stringify(
      {
        browser: { state: hostFinal.state, transport: hostFinal.transport },
        android: {
          state: androidAfterRetransmit.state,
          transport: androidAfterRetransmit.transport,
        },
        cancelled: {
          name: cancelledName,
          size: cancelledSize,
          started: active.transfer.id,
          progressed: progressed.transfer?.done ?? 0,
          senderResult: cancelResult,
          receiverReceived: androidAfterCancel.received.some((item) => item.name === cancelledName),
          temporaryFiles: leftovers,
        },
        retransmit: {
          name: retransmitName,
          bytes: received.size,
          sha256: actualHash,
          expectedSha256: expectedHash,
          transferId: retransmitActive.transfer.id,
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
