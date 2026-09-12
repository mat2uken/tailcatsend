import { expect, test } from "@playwright/test";

test("renders the shared VanJS shell when the backend is unavailable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ponlet" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create invite|招待を作成/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Choose file|ファイルを選択/ })).toBeVisible();
});

async function installBackend(page, { failFirstInvite = false, connected = false } = {}) {
  await page.addInitScript(
    ({ failFirstInvite, connected }) => {
      let listener;
      const calls = [];
      let state = {
        apiVersion: 2,
        sequence: 0,
        state: connected ? "connected" : "ready",
        transport: "unknown",
        peerName: "",
        inviteUrl: null,
        inviteExpiresInSecs: 0,
        canSend: connected,
        canDisconnect: connected,
        transfer: null,
        received: [],
        receivedMessages: [],
        error: null,
      };
      const publish = (extra) => {
        state = { ...state, ...extra, sequence: state.sequence + 1 };
        listener?.({ type: "snapshot", sequence: state.sequence, snapshot: state });
      };
      const text = (value, incoming) => {
        state = { ...state, sequence: state.sequence + 1 };
        listener?.({ type: "text", sequence: state.sequence, text: value, incoming });
      };
      window.__testPonlet = {
        calls,
        publish,
        text,
        terminal(status) {
          const id = state.transfer.id;
          state = { ...state, sequence: state.sequence + 1 };
          listener?.({ type: "terminal", sequence: state.sequence, id, status });
          publish({ state: "connected", canSend: true, transfer: null });
        },
      };
      window.__ponletBackend = {
        snapshot: async () => {
          calls.push("snapshot");
          return state;
        },
        subscribe: (callback) => {
          calls.push("subscribe");
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        createInvite: async () => {
          calls.push("invite");
          if (failFirstInvite) {
            failFirstInvite = false;
            publish({ state: "error", error: "temporary listener failure" });
            throw new Error("temporary listener failure");
          }
          publish({
            state: "awaiting-peer",
            error: null,
            inviteUrl: "https://example.test/#i=test",
            inviteExpiresInSecs: 600,
          });
        },
        qrCode: async () => ({ width: 1, height: 1, rgbaPixels: new Uint8Array([0, 0, 0, 255]) }),
        join: async (invitation) => {
          calls.push(["join", invitation]);
          publish({ state: "connected", inviteUrl: null, canSend: true, canDisconnect: true });
        },
        sendText: async (value) => {
          calls.push(["send", value]);
          // Real native/Rust backends acknowledge sends without an outgoing event.
        },
        sendFiles: async () => {},
        cancelTransfer: async () => {},
        disconnect: async () => {
          calls.push("disconnect");
          publish({ state: "ready", inviteUrl: null, canSend: false, canDisconnect: false });
        },
        dispose: async () => {
          calls.push("dispose");
        },
        openReceivedItem: async () => {},
        copyText: async (value) => {
          calls.push(["copy", value]);
        },
        saveText: async (value) => {
          calls.push(["save", value]);
        },
        shareText: async (value) => {
          calls.push(["share", value]);
        },
        readClipboard: async () => "https://example.test/#i=clipboard",
        openExternal: async (url) => {
          calls.push(["external", url]);
        },
        openDownloads: async () => {
          calls.push("downloads");
        },
        getTelemetryEnabled: async () => false,
        setTelemetryEnabled: async (enabled) => {
          calls.push(["telemetry", enabled]);
        },
      };
    },
    { failFirstInvite, connected },
  );
}

test("restores invitation waiting, live language, expiry and hidden controls", async ({ page }) => {
  await installBackend(page);
  await page.goto("/");
  await expect(page.getByRole("img", { name: "Invitation QR code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeHidden();
  await expect(page.locator('input[type="file"]')).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.getByRole("button", { name: "貼り付けて接続", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("ponlet.language"))).toBe("ja");
  expect(
    await page.evaluate(
      () => window.__testPonlet.calls.filter((call) => call === "subscribe").length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() => window.__testPonlet.calls.filter((call) => call === "invite").length),
  ).toBe(1);
  await page.evaluate(() => window.__testPonlet.publish({ inviteExpiresInSecs: 1 }));
  await expect(page.locator(".invite-expiry")).toContainText("期限切れ", { timeout: 4000 });
  await expect(page.getByRole("button", { name: "招待URLをコピー", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "プライバシーポリシー" }).click();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "external",
    "https://ponlet.mat2uken.app/privacy_ja.html",
  ]);
});

test("retries a failed invitation without disposing the active backend", async ({ page }) => {
  await installBackend(page, { failFirstInvite: true });
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Connection status" })).toContainText(
    "temporary listener failure",
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("img", { name: "Invitation QR code" })).toBeVisible();
  expect(
    await page.evaluate(
      () => window.__testPonlet.calls.filter((call) => call === "subscribe").length,
    ),
  ).toBe(1);
  expect(await page.evaluate(() => window.__testPonlet.calls)).not.toContain("dispose");
});

test("restores clipboard actions, history export and clearing, newest position and terminal feedback", async ({
  page,
}) => {
  await installBackend(page, { connected: true });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message input", exact: true });
  await composer.fill("sent before any reply");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "copy",
    "[Me]: sent before any reply",
  ]);
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "save",
    "[Me]: sent before any reply",
  ]);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await expect(composer).toHaveValue("https://example.test/#i=clipboard");
  await page.getByRole("button", { name: "Clear input", exact: true }).click();
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: "Paste & connect", exact: true }).click();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "join",
    "https://example.test/#i=clipboard",
  ]);
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) {
      window.__testPonlet.text(`message ${i}`, true);
    }
  });
  await expect(page.locator(".message-bubble").first()).toContainText("message 39");
  expect(await page.locator(".message-log").evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Clear history", exact: true }).click();
  await expect(page.locator(".message-bubble")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeDisabled();
  await page.evaluate(() =>
    window.__testPonlet.publish({
      state: "transferring",
      transfer: {
        id: "sent-file",
        name: "report.bin",
        incoming: false,
        done: 20,
        total: 20,
        status: "sending",
      },
    }),
  );
  await expect(page.locator(".transfer-status")).toHaveText("Sending…");
  await page.evaluate(() => window.__testPonlet.terminal("completed"));
  await expect(page.locator(".transfer-status")).toHaveText("Sent successfully");
  await expect(page.locator(".transfer-name")).toHaveText("report.bin");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.locator(".transfer-details")).toBeHidden();
});

test("starts waiting while telemetry preference is still loading", async ({ page }) => {
  await installBackend(page);
  await page.addInitScript(() => {
    window.__ponletBackend.getTelemetryEnabled = () => new Promise(() => {});
  });
  await page.goto("/");
  await expect(page.getByRole("img", { name: "Invitation QR code" })).toBeVisible();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContain("invite");
});
