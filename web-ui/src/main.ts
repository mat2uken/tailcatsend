import van from "vanjs-core";
import { createBackend, initializeBrowserBackend } from "@backend";
import { initialSnapshot, type PonletBackend } from "./api/application-api";
import { Session, type Message, type TransferResult } from "./session";
import { showToast } from "./lib/toast";
import { checkForUpdate } from "./update/client";
import { language, uiText, transportLabel } from "./i18n";
import { createSettingsDialog } from "./components/settings-dialog";
import { canScanWithCamera, createScannerDialog } from "./components/scanner-dialog";
import { createQrView } from "./components/qr-view";
import "./style.css";

const {
  a,
  button,
  div,
  footer,
  header,
  h1,
  h2,
  input,
  label,
  main,
  p,
  progress,
  section,
  span,
  ul,
  li,
  textarea,
} = van.tags;
let backend: PonletBackend | undefined;
function getBackend(): PonletBackend {
  if (!backend) {
    throw new Error(uiText.preparing);
  }
  return backend;
}
const snapshot = van.state(initialSnapshot());
const messages = van.state<Array<Message>>([]);
const lastReceivedText = van.state("");
const lastTransfer = van.state<TransferResult | null>(null);
const transferRate = van.state(0);
const textDraft = van.state("");
const joinDraft = van.state("");
const operationBusy = van.state(false);
let session: Session | undefined;
let starting: Promise<void> | undefined;
const now = van.state(Date.now());
let inviteUrl = "";
let inviteDeadline = 0;
const clock = window.setInterval(() => {
  now.val = Date.now();
}, 1000);

function createSession(): Session {
  return new Session(getBackend(), (view) => {
    now.val = Date.now();
    const nextUrl = view.snapshot.inviteUrl ?? "";
    const remaining = Math.max(0, view.snapshot.inviteExpiresInSecs);
    if (nextUrl !== inviteUrl) {
      inviteUrl = nextUrl;
      inviteDeadline = now.val + remaining * 1000;
    } else if (nextUrl) {
      // Repeated snapshots must never extend an invitation's lifetime.
      inviteDeadline = Math.min(inviteDeadline, now.val + remaining * 1000);
    }
    snapshot.val = view.snapshot;
    messages.val = view.messages;
    lastReceivedText.val = view.lastReceivedText;
    lastTransfer.val = view.lastTransfer;
    transferRate.val = view.transferBytesPerSecond;
  });
}
async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (session) {
      session.reportError(error);
    } else {
      snapshot.val = {
        ...snapshot.val,
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
async function perform(action: () => Promise<void>): Promise<void> {
  if (operationBusy.val) {
    return;
  }
  operationBusy.val = true;
  session?.clearError();
  try {
    await run(action);
  } finally {
    operationBusy.val = false;
  }
}
const settings = createSettingsDialog({
  canConfigureTelemetry: () =>
    Boolean(backend?.getTelemetryEnabled && backend?.setTelemetryEnabled),
  getTelemetryEnabled: () => getBackend().getTelemetryEnabled!(),
  setTelemetryEnabled: (enabled) => getBackend().setTelemetryEnabled!(enabled),
  onError: (error) => {
    showToast(error instanceof Error ? error.message : String(error));
  },
});
const scanner = createScannerDialog();
const qrView = createQrView({ getBackend, onError: (error) => session?.reportError(error) });
window.addEventListener("pagehide", (event) => {
  scanner.closeScanner();
  if (!event.persisted) {
    window.clearInterval(clock);
    if (session) {
      void run(() => session!.dispose());
    }
  }
});

export function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return exponent === 0
    ? `${Math.round(bytes)} B`
    : `${(bytes / Math.pow(1024, exponent)).toFixed(1)} ${units[exponent]}`;
}
function exportText(): string {
  return (
    lastReceivedText.val ||
    messages.val
      .map((message) => `${message.incoming ? "[Peer]" : "[Me]"}: ${message.text}`)
      .join("\n")
  );
}
async function readClipboard(): Promise<string> {
  if (backend?.readClipboard) {
    return backend.readClipboard();
  }
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }
  throw new Error(uiText.clipboardUnavailable);
}

const statusText = span({ class: "status-text" });
const status = div(
  {
    class: "status-pill preparing",
    role: "status",
    "aria-live": "polite",
    "aria-label": () => uiText.statusAriaLabel,
  },
  span({ class: "status-dot" }),
  statusText,
);
const transport = span({ class: "transport-path" });
const peer = span({ class: "peer-name" });
const invite = button({ class: "invite-link", type: "button" }, () => uiText.saved);
const expiry = p({ class: "invite-expiry" });
const log = div({
  class: "message-log",
  role: "log",
  "aria-live": "polite",
  "aria-relevant": "additions",
  "aria-label": () => uiText.messageLogAriaLabel,
});
const transferName = span({ class: "transfer-name" });
const transferStatus = span({ class: "transfer-status", role: "status" });
const transferProgress = progress({
  max: 1,
  value: 0,
  "aria-label": () => uiText.transferProgressAriaLabel,
});
const transferBytes = span({ class: "transfer-bytes" });
const transferSpeed = span({ class: "transfer-bytes transfer-speed" });
const cancelButton = button({ class: "secondary", type: "button" }, () => uiText.cancel);
const dismissButton = button({ class: "secondary", type: "button" }, () => uiText.dismiss);
const transferDetails = div(
  { class: "transfer-details", hidden: true },
  transferStatus,
  transferName,
  transferProgress,
  transferBytes,
  transferSpeed,
  cancelButton,
  dismissButton,
);
const sendButton = button({ class: "primary", type: "button" }, () => uiText.send);
const fileButton = button({ class: "secondary", type: "button" }, () => uiText.chooseFile);
const fileInput = input({
  type: "file",
  multiple: true,
  hidden: true,
  "aria-label": () => uiText.fileInputAriaLabel,
});
const textInput = textarea({
  class: "composer",
  rows: 3,
  placeholder: () => uiText.message,
  "aria-label": () => uiText.messageInputAriaLabel,
  spellcheck: "true",
});
const pasteButton = button({ class: "secondary", type: "button" }, () => uiText.paste);
const clearDraftButton = button({ class: "secondary", type: "button" }, () => uiText.clearDraft);
const clearHistoryButton = button(
  { class: "secondary", type: "button" },
  () => uiText.clearHistory,
);
const copyTextButton = button({ class: "secondary", type: "button" }, () => uiText.copy);
const shareTextButton = button({ class: "secondary", type: "button" }, () => uiText.share);
const saveTextButton = button({ class: "secondary", type: "button" }, () => uiText.save);
const downloadsButton = button(
  { class: "secondary", type: "button", hidden: true },
  () => uiText.downloads,
);
const receivedList = ul({ class: "received-list" });
const joinInput = input({
  class: "join-input",
  type: "url",
  inputmode: "url",
  placeholder: () => uiText.invitation,
  autocomplete: "off",
  autocapitalize: "off",
  spellcheck: "false",
  "aria-label": () => uiText.joinInputAriaLabel,
});
const scanButton = button({ class: "secondary", type: "button" }, () => uiText.scan);
const pasteJoinButton = button({ class: "secondary", type: "button" }, () => uiText.pasteJoin);
const invitationFromHash = window.location.hash.startsWith("#i=")
  ? `${window.location.origin}${window.location.pathname}${window.location.hash}`
  : "";
if (invitationFromHash) {
  joinDraft.val = invitationFromHash;
  joinInput.value = invitationFromHash;
}
const connectButton = button({ class: "primary", type: "button" }, () => uiText.connect);
const createButton = button({ class: "secondary", type: "button" }, () =>
  snapshot.val.inviteUrl ? uiText.regenerate : uiText.createInvite,
);
const disconnectButton = button({ class: "secondary", type: "button" }, () => uiText.disconnect);
const retryButton = button(
  { class: "secondary", type: "button", hidden: true },
  () => uiText.retry,
);
const settingsButton = button(
  { class: "icon-button", type: "button", "aria-label": () => uiText.settings },
  "⚙",
);

van.derive(() => {
  document.documentElement.lang = language.val;
  const value = snapshot.val;
  const remaining = Math.max(0, Math.ceil((inviteDeadline - now.val) / 1000));
  const expired = Boolean(value.inviteUrl) && remaining === 0;
  // Reading the clock updates expiry without issuing another QR request every second.
  expiry.hidden = !value.inviteUrl;
  expiry.classList.toggle("expired", expired);
  expiry.textContent = expired
    ? uiText.expired
    : `${uiText.expires}: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  const active = value.transfer;
  const stateClass =
    value.error || expired
      ? "error"
      : active || value.state === "connected"
        ? "connected"
        : value.state === "ready"
          ? "ready"
          : value.state === "awaiting-peer"
            ? "waiting"
            : "preparing";
  status.className = `status-pill ${stateClass}`;
  statusText.textContent =
    value.error ??
    (expired
      ? uiText.expired
      : active
        ? active.incoming
          ? uiText.receiving
          : uiText.sending
        : value.state === "connected"
          ? uiText.connected
          : value.state === "ready"
            ? uiText.ready
            : value.state === "awaiting-peer"
              ? uiText.waiting
              : uiText.preparing);
  transport.textContent = transportLabel(value.transport);
  peer.textContent = value.peerName || uiText.app;
  invite.hidden = !value.inviteUrl;
  invite.disabled = expired;
  disconnectButton.hidden = !value.canDisconnect;
  const busy = operationBusy.val || active != null;
  // A failed invitation or join remains retryable without reloading the app.
  connectButton.disabled = createButton.disabled = !backend || busy || value.state === "booting";
  pasteJoinButton.disabled = connectButton.disabled;
  sendButton.disabled = busy || !value.canSend || !textDraft.val.trim();
  fileButton.disabled = busy || !value.canSend;
  pasteButton.disabled = operationBusy.val;
  clearDraftButton.disabled = !textDraft.val;
  clearHistoryButton.disabled = messages.val.length === 0;
  scanButton.disabled = !backend || busy || !(backend.scanQr || canScanWithCamera());
  scanButton.title = !backend?.scanQr && !canScanWithCamera() ? uiText.scanUnavailable : "";
  retryButton.hidden = !value.error;
  retryButton.disabled = busy;
  downloadsButton.hidden = !backend?.openDownloads;
  copyTextButton.disabled = shareTextButton.disabled = saveTextButton.disabled = !exportText();
  const result = active ?? lastTransfer.val;
  transferDetails.hidden = !result;
  cancelButton.hidden = !active;
  dismissButton.hidden = Boolean(active) || !result;
  transferSpeed.hidden = !active;
  if (result) {
    transferName.textContent = result.name;
    transferName.title = result.name;
    const ratio = result.total ? result.done / result.total : result.status === "completed" ? 1 : 0;
    transferProgress.value = result.status === "completed" ? 1 : Math.min(1, Math.max(0, ratio));
    transferStatus.textContent = active
      ? active.incoming
        ? uiText.receiving
        : uiText.sending
      : result.status === "completed"
        ? result.incoming
          ? uiText.received
          : uiText.sent
        : result.status === "cancelled"
          ? uiText.cancelled
          : lastTransfer.val?.message || uiText.failed;
    transferBytes.textContent = `${formatBytes(result.status === "completed" ? result.total : result.done)} / ${formatBytes(result.total)} (${Math.round(transferProgress.value * 100)}%)`;
    transferSpeed.textContent = `${formatBytes(transferRate.val)}/s`;
  }
});
van.derive(() => {
  void qrView.renderInviteQr(snapshot.val.inviteUrl);
});
van.derive(() => {
  const items = snapshot.val.received;
  if (!items.length) {
    receivedList.replaceChildren(
      li(
        { class: "empty-state" },
        p({ class: "empty-state-title" }, () => uiText.noReceivedFiles),
        p({ class: "empty-state-hint" }, () => uiText.noReceivedFilesHint),
      ),
    );
    return;
  }
  receivedList.replaceChildren(
    ...items.map((item) => {
      const pathButton = button({ class: "secondary", type: "button" }, () => uiText.copyPath);
      const openButton = button({ class: "secondary", type: "button" }, () => uiText.openFile);
      pathButton.addEventListener(
        "click",
        () =>
          void run(async () => {
            await getBackend().copyText(item.localPathOrHandle);
            showToast(uiText.copiedPath);
          }),
      );
      openButton.addEventListener(
        "click",
        () => void run(() => getBackend().openReceivedItem(item)),
      );
      return li(
        { class: "received-item" },
        div(
          { class: "received-item-meta", title: item.name },
          item.name,
          span({ class: "received-item-size" }, formatBytes(item.size)),
        ),
        div({ class: "received-item-actions" }, openButton, pathButton),
      );
    }),
  );
});
van.derive(() => {
  const previousHeight = log.scrollHeight;
  const previousTop = log.scrollTop;
  const atNewest = previousTop < 24;
  const items = messages.val;
  log.replaceChildren(
    ...(items.length
      ? items.map((message) =>
          p(
            { class: `message-bubble ${message.incoming ? "incoming" : "outgoing"}` },
            span({ class: "message-sender" }, message.incoming ? "[Peer]: " : "[Me]: "),
            span({ class: "message-text" }, message.text),
          ),
        )
      : [
          div(
            { class: "empty-state" },
            p({ class: "empty-state-title" }, () => uiText.noMessages),
            p({ class: "empty-state-hint" }, () => uiText.noMessagesHint),
          ),
        ]),
  );
  // Messages are newest first. Preserve an older reading position when new items arrive.
  log.scrollTop = atNewest ? 0 : Math.max(0, previousTop + log.scrollHeight - previousHeight);
});
textInput.addEventListener("input", () => {
  textDraft.val = textInput.value;
});
textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendButton.click();
  }
});
sendButton.addEventListener(
  "click",
  () =>
    void perform(async () => {
      const text = textDraft.val;
      if (!text.trim() || !snapshot.val.canSend) {
        return;
      }
      const previousMessages = session?.view.messages;
      await getBackend().sendText(text);
      session?.recordSentText(text, previousMessages);
      if (textDraft.val === text) {
        textDraft.val = "";
        textInput.value = "";
      }
      textInput.focus();
    }),
);
pasteButton.addEventListener(
  "click",
  () =>
    void perform(async () => {
      const text = await readClipboard();
      textInput.setRangeText(text, textInput.selectionStart, textInput.selectionEnd, "end");
      textDraft.val = textInput.value;
      textInput.focus();
    }),
);
clearDraftButton.addEventListener("click", () => {
  textDraft.val = "";
  textInput.value = "";
  textInput.focus();
});
clearHistoryButton.addEventListener("click", () => {
  session?.clearHistory();
  showToast(uiText.historyCleared);
});
fileButton.addEventListener("click", () => {
  if (backend?.pickAndSendFiles) {
    void perform(() => backend!.pickAndSendFiles!());
  } else {
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = "";
  if (files.length && snapshot.val.canSend) {
    void perform(() => getBackend().sendFiles(files));
  }
});
cancelButton.addEventListener("click", () => {
  const id = snapshot.val.transfer?.id;
  if (id) {
    void run(() => getBackend().cancelTransfer(id));
  }
});
dismissButton.addEventListener("click", () => session?.dismissTransfer());
joinInput.addEventListener("input", () => {
  joinDraft.val = joinInput.value;
});
joinInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    connectButton.click();
  }
});
connectButton.addEventListener("click", () => {
  const invitation = joinDraft.val.trim();
  if (invitation) {
    void perform(() => getBackend().join(invitation));
  }
});
pasteJoinButton.addEventListener(
  "click",
  () =>
    void perform(async () => {
      const invitation = (await readClipboard()).trim();
      joinDraft.val = invitation;
      joinInput.value = invitation;
      if (invitation) {
        await getBackend().join(invitation);
      }
    }),
);
scanButton.addEventListener(
  "click",
  () =>
    void perform(async () => {
      const native = getBackend();
      const invitation =
        native.scanQr && native.cancelScan
          ? await scanner.openNativeScanner(
              () => native.scanQr!(),
              () => native.cancelScan!(),
              scanButton,
            )
          : native.scanQr
            ? await native.scanQr()
            : await scanner.openScanner(scanButton);
      if (invitation) {
        joinDraft.val = invitation;
        joinInput.value = invitation;
        await native.join(invitation);
      }
    }),
);
createButton.addEventListener("click", () => void perform(() => getBackend().createInvite()));
disconnectButton.addEventListener(
  "click",
  () =>
    void perform(async () => {
      await getBackend().disconnect();
      await getBackend().createInvite();
    }),
);
settingsButton.addEventListener("click", () => settings.openSettings(settingsButton));
copyTextButton.addEventListener("click", () => {
  const text = exportText();
  if (text) {
    void run(async () => {
      await getBackend().copyText(text);
      showToast(uiText.copiedMessage);
    });
  }
});
shareTextButton.addEventListener("click", () => {
  const text = exportText();
  if (text) {
    void run(() => getBackend().shareText(text));
  }
});
saveTextButton.addEventListener("click", () => {
  const text = exportText();
  if (text) {
    void run(() => getBackend().saveText(text));
  }
});
downloadsButton.addEventListener("click", () => void run(() => getBackend().openDownloads!()));
invite.addEventListener("click", () => {
  const url = snapshot.val.inviteUrl;
  if (url) {
    void run(async () => {
      await getBackend().copyText(url);
      showToast(uiText.copiedInvite, { anchor: invite, duration: 1200 });
    });
  }
});
function externalLink(url: () => string, text: () => string): HTMLAnchorElement {
  const link = a({ href: url, target: "_blank", rel: "noopener noreferrer" }, text);
  link.addEventListener("click", (event) => {
    if (backend?.openExternal) {
      event.preventDefault();
      void run(() => backend!.openExternal!(url()));
    }
  });
  return link;
}
retryButton.addEventListener(
  "click",
  () =>
    void perform(async () => {
      if (!backend) {
        await startApplication(false);
      } else if (snapshot.val.inviteUrl) {
        await qrView.renderInviteQr(snapshot.val.inviteUrl, true);
      } else {
        await getBackend().createInvite();
      }
    }),
);
document.body.append(
  settings.dialog,
  scanner.dialog,
  header(
    { class: "topbar" },
    h1(() => uiText.app),
    div({ class: "topbar-actions" }, peer, settingsButton),
  ),
  main(
    { class: "shell" },
    section(
      { class: "connection-card" },
      div({ class: "connection-status-row" }, status, transport, retryButton),
      qrView.container,
      expiry,
      invite,
      div(
        { class: "connection-actions" },
        joinInput,
        connectButton,
        pasteJoinButton,
        scanButton,
        createButton,
        disconnectButton,
      ),
    ),
    section(
      { class: "transfer-card" },
      h2(() => uiText.transfer),
      div({ class: "transfer-row" }, fileButton, fileInput),
      transferDetails,
      h2(() => uiText.receivedFiles),
      downloadsButton,
      receivedList,
    ),
    section(
      { class: "chat-card" },
      h2(() => uiText.messages),
      log,
      div(
        { class: "message-actions" },
        copyTextButton,
        shareTextButton,
        saveTextButton,
        clearHistoryButton,
      ),
      label({ class: "composer-label" }, textInput),
      div(
        { class: "composer-actions" },
        sendButton,
        pasteButton,
        clearDraftButton,
        span({ class: "draft-count" }, () => `${Array.from(textDraft.val).length}`),
      ),
    ),
  ),
  footer(
    { class: "footer" },
    p(() => uiText.footer),
    div(
      { class: "footer-links" },
      externalLink(
        () => `https://ponlet.mat2uken.app/privacy_${language.val}.html`,
        () => uiText.privacy,
      ),
      externalLink(
        () => "https://ponlet.mat2uken.app/licenses.html",
        () => uiText.licenses,
      ),
    ),
  ),
);
async function startApplication(joinFromLocation = true): Promise<void> {
  if (starting) {
    return starting;
  }
  starting = (async () => {
    snapshot.val = initialSnapshot();
    try {
      await initializeBrowserBackend();
      backend = createBackend();
      session = createSession();
      await session.start();
      void settings.refreshSettings();
      if (snapshot.val.state === "error" || snapshot.val.error) {
        return;
      }
      if (joinFromLocation && invitationFromHash) {
        await getBackend().join(invitationFromHash);
      } else if (snapshot.val.state === "ready" && !snapshot.val.inviteUrl) {
        await getBackend().createInvite();
      }
    } catch (error) {
      await run(async () => {
        throw error;
      });
    }
  })();
  try {
    await starting;
  } finally {
    starting = undefined;
  }
}
void checkForUpdate();
void startApplication();
