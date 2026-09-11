import van from "vanjs-core";
import { createBackend, initializeBrowserBackend } from "@backend";
import { initialSnapshot, type PonletBackend } from "./api/application-api";
import { Session, type Message } from "./session";
import { showToast } from "./lib/toast";
import { checkForUpdate } from "./update/client";
import { uiText, transportLabel } from "./i18n";
import { createSettingsDialog } from "./components/settings-dialog";
import { createScannerDialog } from "./components/scanner-dialog";
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

let backend: PonletBackend = createBackend();
const snapshot = van.state(initialSnapshot());
const messages = van.state<Array<Message>>([]);
const lastReceivedText = van.state("");
const textDraft = van.state("");
const joinDraft = van.state("");
const operationBusy = van.state(false);
let session: Session | undefined;

function createSession(): Session {
  return new Session(backend, (view) => {
    snapshot.val = view.snapshot;
    messages.val = view.messages;
    lastReceivedText.val = view.lastReceivedText;
  });
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (session) {
      session.reportError(error);
    } else {
      snapshot.val = { ...snapshot.val, state: "error", error: String(error) };
    }
  }
}

async function perform(action: () => Promise<void>): Promise<void> {
  if (operationBusy.val) {
    return;
  }
  operationBusy.val = true;
  try {
    await run(action);
  } finally {
    operationBusy.val = false;
  }
}

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    if (session) {
      void run(() => session!.dispose());
    }
  }
});

const settings = createSettingsDialog();
const scanner = createScannerDialog();
const qrView = createQrView({
  getBackend: () => backend,
  onError: (error) => {
    snapshot.val = { ...snapshot.val, error: String(error) };
  },
});

const status = span({ class: "status" });
const transport = span({ class: "transport-path" });
const peer = span({ class: "peer-name" });
const invite = a({ class: "invite-link", target: "_blank", rel: "noreferrer" });
const log = div({ class: "message-log", role: "log" });
const transferName = span({ class: "transfer-name" });
const transferProgress = progress({ max: 1, value: 0 });
const transferBytes = span({ class: "transfer-bytes" });
const cancelButton = button({ class: "secondary", type: "button" }, uiText.cancel);
const sendButton = button({ class: "primary", type: "button" }, uiText.send);
const fileButton = button({ class: "secondary", type: "button" }, uiText.chooseFile);
const fileInput = input({ type: "file", multiple: true, hidden: true });
const textInput = textarea({ class: "composer", rows: 3, placeholder: uiText.message });
const copyTextButton = button({ class: "secondary", type: "button" }, uiText.copy);
const shareTextButton = button({ class: "secondary", type: "button" }, uiText.share);
const saveTextButton = button({ class: "secondary", type: "button" }, uiText.save);
const receivedList = ul({ class: "received-list" });
const joinInput = input({ class: "join-input", placeholder: uiText.invitation });
const scanButton = button({ class: "secondary", type: "button" }, uiText.scan);
const invitationFromHash = window.location.hash.startsWith("#i=")
  ? `${window.location.origin}${window.location.pathname}${window.location.hash}`
  : "";
if (invitationFromHash) {
  joinDraft.val = invitationFromHash;
  joinInput.value = invitationFromHash;
}
const connectButton = button({ class: "primary", type: "button" }, uiText.connect);
const createButton = button({ class: "secondary", type: "button" }, uiText.createInvite);
const disconnectButton = button({ class: "secondary", type: "button" }, uiText.disconnect);
const settingsButton = button(
  { class: "icon-button", type: "button", "aria-label": uiText.settings },
  "⚙",
);

van.derive(() => {
  const value = snapshot.val;
  void qrView.renderInviteQr(value.inviteUrl);
  status.textContent =
    value.error ??
    (value.state === "ready"
      ? uiText.ready
      : value.state === "connected"
        ? uiText.connected
        : value.state === "awaiting-peer"
          ? uiText.waiting
          : uiText.preparing);
  transport.textContent = transportLabel(value.transport);
  peer.textContent = value.peerName || uiText.app;
  invite.textContent = value.inviteUrl ? uiText.saved : "";
  invite.href = "#";
  invite.hidden = !value.inviteUrl;
  disconnectButton.hidden = !value.canDisconnect;
  const hasTransfer = value.transfer != null;
  const busy = operationBusy.val || hasTransfer;
  connectButton.disabled = busy || value.state === "booting" || value.state === "error";
  createButton.disabled = busy || value.state === "booting" || value.state === "error";
  sendButton.disabled = busy || !value.canSend || !textDraft.val.trim();
  fileButton.disabled = busy || !value.canSend;
  scanButton.disabled = busy || !("BarcodeDetector" in globalThis);
  scanButton.title =
    scanButton.disabled && !("BarcodeDetector" in globalThis) ? uiText.scanUnavailable : "";
  cancelButton.hidden = !hasTransfer;
  copyTextButton.disabled =
    shareTextButton.disabled =
    saveTextButton.disabled =
      !lastReceivedText.val;
  if (value.transfer) {
    transferName.textContent = value.transfer.name;
    transferProgress.value = value.transfer.total ? value.transfer.done / value.transfer.total : 0;
    transferBytes.textContent = `${value.transfer.done.toLocaleString()} / ${value.transfer.total.toLocaleString()} bytes`;
  } else {
    transferName.textContent = "";
    transferProgress.value = 0;
    transferBytes.textContent = "";
  }
});

van.derive(() => {
  receivedList.replaceChildren(
    ...snapshot.val.received.map((item) => {
      const pathButton = button({ class: "secondary", type: "button" }, uiText.copyPath);
      const openButton = button({ class: "secondary", type: "button" }, uiText.openFile);
      pathButton.addEventListener(
        "click",
        () =>
          void run(async () => {
            await backend.copyText(item.localPathOrHandle);
            showToast(uiText.copiedPath);
          }),
      );
      openButton.addEventListener("click", () => void run(() => backend.openReceivedItem(item)));
      return li(
        { class: "received-item" },
        div(
          { class: "received-item-meta" },
          item.name,
          span({ class: "received-item-size" }, `${item.size.toLocaleString()} bytes`),
        ),
        div({ class: "received-item-actions" }, openButton, pathButton),
      );
    }),
  );
});

van.derive(() => {
  log.replaceChildren(
    ...messages.val.map((message) =>
      p({ class: "message" }, `${message.incoming ? "[Peer]" : "[Me]"}: ${message.text}`),
    ),
  );
});

textInput.addEventListener("input", () => (textDraft.val = textInput.value));
textInput.addEventListener("keydown", (event) => {
  // Japanese IME uses Enter to commit composition.  Only an ordinary,
  // non-composing Enter submits the message; Shift+Enter keeps a newline.
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
      await backend.sendText(text);
      // Keep text entered while the previous send was awaiting completion.
      if (textDraft.val === text) {
        textDraft.val = "";
        textInput.value = "";
      }
    }),
);
fileButton.addEventListener("click", () => {
  if (backend.pickAndSendFiles) {
    void perform(() => backend.pickAndSendFiles!());
  } else {
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = "";
  if (files.length && snapshot.val.canSend) {
    void perform(() => backend.sendFiles(files));
  }
});
cancelButton.addEventListener("click", () => {
  const id = snapshot.val.transfer?.id;
  if (id) {
    void run(() => backend.cancelTransfer(id));
  }
});
joinInput.addEventListener("input", () => (joinDraft.val = joinInput.value));
connectButton.addEventListener("click", () => {
  const invite = joinDraft.val.trim();
  if (invite) {
    void perform(() => backend.join(invite));
  }
});
scanButton.addEventListener("click", () => {
  void perform(async () => {
    const invite = await scanner.openScanner(scanButton);
    if (invite) {
      joinDraft.val = invite;
      joinInput.value = invite;
      await backend.join(invite);
    }
  });
});
createButton.addEventListener("click", () => void perform(() => backend.createInvite()));
disconnectButton.addEventListener("click", () => void run(() => backend.disconnect()));
settingsButton.addEventListener("click", () => {
  settings.openSettings(settingsButton);
});
copyTextButton.addEventListener("click", () => {
  if (lastReceivedText.val) {
    void run(async () => {
      await backend.copyText(lastReceivedText.val);
      showToast(uiText.copiedMessage);
    });
  }
});
shareTextButton.addEventListener("click", () => {
  if (lastReceivedText.val) {
    void run(() => backend.shareText(lastReceivedText.val));
  }
});
saveTextButton.addEventListener("click", () => {
  if (lastReceivedText.val) {
    void run(() => backend.saveText(lastReceivedText.val));
  }
});
document.body.append(settings.dialog, scanner.dialog);
invite.addEventListener("click", (event) => {
  event.preventDefault();
  const inviteUrl = snapshot.val.inviteUrl;
  if (!inviteUrl) {
    return;
  }
  void run(async () => {
    await backend.copyText(inviteUrl);
    showToast(uiText.copiedInvite, { anchor: invite, duration: 1200 });
  });
});

document.body.append(
  header(
    { class: "topbar" },
    h1(uiText.app),
    div({ class: "topbar-actions" }, peer, settingsButton),
  ),
  main(
    { class: "shell" },
    section(
      { class: "connection-card" },
      status,
      transport,
      qrView.label,
      qrView.canvas,
      div(
        { class: "connection-actions" },
        joinInput,
        connectButton,
        scanButton,
        createButton,
        disconnectButton,
      ),
      invite,
    ),
    section(
      { class: "transfer-card" },
      h2(uiText.transfer),
      div(
        { class: "transfer-row" },
        fileButton,
        fileInput,
        transferName,
        transferProgress,
        transferBytes,
        cancelButton,
      ),
      h2(uiText.receivedFiles),
      receivedList,
    ),
    section(
      { class: "chat-card" },
      h2(uiText.messages),
      log,
      div({ class: "message-actions" }, copyTextButton, shareTextButton, saveTextButton),
      label({ class: "composer-label" }, textInput),
      div({ class: "composer-actions" }, sendButton),
    ),
  ),
  footer({ class: "footer" }, "P2P transfer · end-to-end encrypted"),
);

async function startApplication(): Promise<void> {
  void checkForUpdate();
  try {
    await initializeBrowserBackend();
    backend = createBackend();
    session = createSession();
    await session.start();
    if (invitationFromHash && snapshot.val.state !== "error") {
      void perform(() => backend.join(invitationFromHash));
    }
  } catch (error) {
    await run(async () => {
      throw error;
    });
  }
}

void startApplication();
