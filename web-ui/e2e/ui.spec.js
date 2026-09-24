import { expect, test } from "@playwright/test";

test("renders the shared VanJS shell when the backend is unavailable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ponlet" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create invite|招待を作成/ })).toBeVisible();
  await expect(page.locator(".workspace")).toBeHidden();
  await expect(page.getByRole("button", { name: /Choose file|ファイルを選択/ })).toBeHidden();
});

test("switches QR and join panes on a narrow disconnected screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await installBackend(page);
  await page.goto("/");
  await expect(page.getByRole("img", { name: "Invitation QR code" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Invitation URL", exact: true })).toBeHidden();
  await page.getByRole("tab", { name: "Join a peer", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Invitation URL", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Invitation QR code" })).toBeHidden();
  await page.getByRole("tab", { name: "Show QR", exact: true }).click();
  await expect(page.getByRole("img", { name: "Invitation QR code" })).toBeVisible();
  await expect(page.locator(".workspace")).toBeHidden();
});

async function installBackend(
  page,
  { failFirstInvite = false, connected = false, macScanPreview = false } = {},
) {
  await page.addInitScript(
    ({ failFirstInvite, connected, macScanPreview }) => {
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
        preview(image) {
          this.onPreview?.(image);
        },
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
        ...(macScanPreview
          ? {
              scanQr: async () => null,
              scanQrWithPreview: (onPreview) => {
                window.__testPonlet.onPreview = onPreview;
                return new Promise((resolve) => {
                  window.__testPonlet.finishScan = resolve;
                });
              },
              cancelScan: async () => window.__testPonlet.finishScan?.(null),
            }
          : {}),
      };
    },
    { failFirstInvite, connected, macScanPreview },
  );
}

test("shows macOS preview frames inside the scanner dialog and clears them on close", async ({
  page,
}) => {
  await installBackend(page, { macScanPreview: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Scan with camera" }).click();
  const dialog = page.locator(".scanner-dialog");
  const preview = dialog.locator(".scanner-image");
  await expect(dialog).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(dialog.locator(".scanner-reticle")).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/native-scanning/);
  await page.evaluate(() => window.__testPonlet.preview("data:image/jpeg;base64,frame"));
  await expect(preview).toHaveAttribute("src", "data:image/jpeg;base64,frame");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(preview).not.toHaveAttribute("src");
  await page.evaluate(() => window.__testPonlet.preview("data:image/jpeg;base64,late"));
  await expect(preview).not.toHaveAttribute("src");
});

test("keeps long received filenames and message controls inside a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await installBackend(page, { connected: true });
  await page.goto("/");
  await page.evaluate(() => {
    window.__testPonlet.publish({
      received: [
        {
          id: "narrow-file",
          name: `long-file-${"日本語".repeat(40)}.bin`,
          size: 131071,
          localPathOrHandle: "/received/narrow-file.bin",
        },
      ],
    });
    window.__testPonlet.text("A".repeat(240), true);
  });
  await expect(page.locator(".received-item")).toHaveCount(1);
  await expect(page.locator(".transfer-card")).toBeVisible();
  await expect(page.locator(".chat-card")).toBeHidden();
  for (const selector of [".connection-card", ".transfer-card", ".received-item"]) {
    const rect = await page.locator(selector).boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(360);
  }
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(360);
  await page.getByRole("tab", { name: "Messages" }).click();
  await expect(page.locator(".chat-card")).toBeVisible();
  const composerRect = await page.locator(".composer").boundingBox();
  expect(composerRect.x).toBeGreaterThanOrEqual(0);
  expect(composerRect.x + composerRect.width).toBeLessThanOrEqual(360);
  await page.getByRole("textbox", { name: "Message input", exact: true }).fill("narrow reply");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".message-bubble.outgoing")).toContainText("narrow reply");
});

test("keeps a received pasted message together when copying it", async ({ page }) => {
  await installBackend(page, { connected: true });
  await page.goto("/");
  await page.getByRole("tab", { name: "Messages" }).click();

  const pasted = "first line\nsecond line\nthird line";
  await page.evaluate((value) => window.__testPonlet.text(value, true), pasted);
  await expect(page.locator(".message-row.incoming")).toHaveCount(1);

  await page.locator(".message-row.incoming .message-menu-button").click();
  await page
    .locator(".message-row.incoming .message-menu:not([hidden])")
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual(["copy", pasted]);

  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "copy",
    `[Peer]: ${pasted}`,
  ]);
});

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
  await page.locator("#settings-telemetry-toggle").check();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual(["telemetry", true]);
  await page.getByRole("link", { name: "プライバシーポリシー" }).click();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "external",
    "https://ponlet.mat2uken.app/privacy_ja.html",
  ]);
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
  await page.getByRole("tab", { name: "Messages" }).click();
  const composer = page.getByRole("textbox", { name: "Message input", exact: true });
  await composer.fill("sent before any reply");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "copy",
    "[Me]: sent before any reply",
  ]);
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "save",
    "[Me]: sent before any reply",
  ]);
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "share",
    "[Me]: sent before any reply",
  ]);
  await page.locator(".message-row.outgoing .message-menu-button").click();
  await page
    .locator(".message-row.outgoing .message-menu:not([hidden])")
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.__testPonlet.calls.filter(
        (call) => call[0] === "copy" && call[1] === "sent before any reply",
      ).length >= 1,
  );
  expect(
    await page.evaluate(
      () =>
        window.__testPonlet.calls.filter(
          (call) => call[0] === "copy" && call[1] === "sent before any reply",
        ).length,
    ),
  ).toBe(1);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await expect(composer).toHaveValue("https://example.test/#i=clipboard");
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("button", { name: "Clear input", exact: true }).click();
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("img", { name: "Invitation QR code" })).toBeVisible();
  await page.getByRole("button", { name: "Paste & connect", exact: true }).click();
  expect(await page.evaluate(() => window.__testPonlet.calls)).toContainEqual([
    "join",
    "https://example.test/#i=clipboard",
  ]);
  await page.getByRole("tab", { name: "Messages" }).click();
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) {
      window.__testPonlet.text(`message ${i}`, true);
    }
  });
  await expect(page.locator(".message-bubble").last()).toContainText("message 39");
  const messageMetrics = await page.locator(".message-log").evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(messageMetrics.scrollHeight).toBeGreaterThan(messageMetrics.clientHeight);
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("button", { name: "Clear history", exact: true }).click();
  await expect(page.locator(".message-bubble")).toHaveCount(0);
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
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
  await page.getByRole("tab", { name: "Transfer" }).click();
  await expect(page.locator(".transfer-status")).toHaveText("Sending…");
  await page.evaluate(() => window.__testPonlet.terminal("completed"));
  await expect(page.locator(".transfer-status")).toHaveText("Sent successfully");
  await expect(page.locator(".transfer-name")).toHaveText("report.bin");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.locator(".transfer-details")).toBeHidden();
});

test("explains that the displayed route is observed by this endpoint", async ({ page }) => {
  await installBackend(page, { connected: true });
  await page.goto("/");
  await page.evaluate(() =>
    window.__testPonlet.publish({ transport: "webrtc", peerName: "Phone" }),
  );
  const route = page.locator(".transport-path");
  await expect(route).toHaveText("Path observed on this device: WebRTC DataChannel");
  await expect(route).toHaveAttribute("title", /last path observed by this device/);
  await page.getByRole("button", { name: "Connection details", exact: true }).click();
  await expect(page.locator(".connection-info-panel")).toContainText("Phone");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(route).toHaveText("この端末で確認した経路: WebRTC DataChannel");
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
