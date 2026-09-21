import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import playwright from "../../web-ui/node_modules/playwright/index.js";
import { serveStatic } from "./static-server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = resolve(process.env.PONLET_TEST_DIST ?? resolve(root, "dist"));
const { server, port } = await serveStatic({ dist, uiDist: dist });
let browser;
let fixtureTimer;
try {
  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/wasm/tailsend_web.js`);
  const results = await Promise.race([
    page.evaluate(async () => {
      const wasm = await import("/wasm/tailsend_web.js");
      await wasm.default();
      const listeners = [];
      let lateClosed = 0;
      const unhandledRejections = [];
      window.addEventListener("unhandledrejection", (event) => {
        event.preventDefault();
        unhandledRejections.push(String(event.reason));
      });
      window.tailSendTailcat = {
        listen(options) {
          const listener = { callback: options.onConnection };
          listeners.push(listener);
          return Promise.resolve({
            addr: "tc-test-listener",
            close() {
              return (listener.closePromise ??= new Promise((resolveClose) => {
                listener.resolveClose = resolveClose;
              }));
            },
          });
        },
      };
      wasm.install_backend();
      let dropped = 0;
      const rounds = 20;
      for (let index = 0; index < rounds; index++) {
        await window.__ponletBackend.createInvite();
        const listener = listeners.at(-1);
        const disconnect = window.__ponletBackend.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 0));
        listener.resolveClose();
        await disconnect;
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          // Diagnostic probe only: the Go gate must never invoke this after
          // close resolves. A thrown dropped-closure error proves Rust released it.
          listener.callback({
            port: 100,
            close() {
              return Promise.resolve();
            },
          });
        } catch (error) {
          if (!String(error).includes("closure")) throw error;
          dropped++;
        }
      }
      // A callback queued before the Go close gate shuts must remain callable
      // while its close Promise is pending, and its connection must be closed.
      for (const failClose of [false, true]) {
        await window.__ponletBackend.createInvite();
        const listener = listeners.at(-1);
        const disconnect = window.__ponletBackend.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 0));
        listener.callback({
          port: 100,
          close() {
            lateClosed++;
            return failClose ? Promise.reject(new Error("late close failed")) : Promise.resolve();
          },
        });
        listener.resolveClose();
        await disconnect;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { rounds, dropped, retained: rounds - dropped, lateClosed, unhandledRejections };
    }),
    new Promise((_, reject) => {
      fixtureTimer = setTimeout(
        () => reject(new Error("listener fixture exceeded 20 seconds")),
        20_000,
      );
    }),
  ]);
  console.log(JSON.stringify(results));
  assert.equal(results.retained, 0, "listener callbacks still retained after disconnect");
  assert.equal(results.lateClosed, 2, "connections arriving during close must be closed");
  assert.deepEqual(results.unhandledRejections, [], "late close errors must be consumed");
} finally {
  clearTimeout(fixtureTimer);
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
