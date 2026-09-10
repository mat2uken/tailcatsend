import van from "vanjs-core";
import { createBackend, initializeBrowserBackend } from "@backend";
import { initialSnapshot, type PonletBackend } from "./api/application-api";
import { Session, type Message } from "./session";
import { placeAnchor } from "./lib/position";
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
  textarea,
} = van.tags;

const isJapanese = navigator.language.toLowerCase().startsWith("ja");
const uiText = isJapanese
  ? {
      app: "Ponlet",
      cancel: "キャンセル",
      send: "送信",
      chooseFile: "ファイルを選択",
      copy: "コピー",
      share: "共有",
      save: "保存",
      invitation: "招待URLを貼り付け",
      connect: "接続",
      createInvite: "招待を作成",
      disconnect: "切断",
      settings: "設定",
      close: "閉じる",
      settingsDescription: "この移行用UIの設定画面は準備中です。",
      message: "メッセージ",
      transfer: "転送",
      messages: "メッセージ",
      preparing: "安全なP2P通信を準備中…",
      connected: "接続済み",
      waiting: "相手を待機中",
      peer: "相手",
      saved: "招待URLをコピー",
    }
  : {
      app: "Ponlet",
      cancel: "Cancel",
      send: "Send",
      chooseFile: "Choose file",
      copy: "Copy",
      share: "Share",
      save: "Save",
      invitation: "Paste invitation URL",
      connect: "Connect",
      createInvite: "Create invite",
      disconnect: "Disconnect",
      settings: "Settings",
      close: "Close",
      settingsDescription: "Settings are not available in this migration UI yet.",
      message: "Message",
      transfer: "Transfer",
      messages: "Messages",
      preparing: "Preparing secure P2P network…",
      connected: "Connected",
      waiting: "Waiting for peer",
      peer: "Peer",
      saved: "Copy invitation",
    };

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

const status = span({ class: "status" });
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
const joinInput = input({ class: "join-input", placeholder: uiText.invitation });
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
const settingsDialog = document.createElement("dialog");
let settingsReturnFocus: HTMLElement | null = null;
settingsDialog.className = "settings-dialog";
settingsDialog.append(
  h2(uiText.settings),
  p(uiText.settingsDescription),
  button({ type: "button", onclick: () => closeSettings() }, uiText.close),
);

function closeSettings(): void {
  if (typeof settingsDialog.close === "function") {
    settingsDialog.close();
  } else {
    settingsDialog.removeAttribute("open");
  }
  settingsReturnFocus?.focus();
  settingsReturnFocus = null;
}

van.derive(() => {
  const value = snapshot.val;
  status.textContent =
    value.error ??
    (value.state === "connected"
      ? uiText.connected
      : value.state === "awaiting-peer"
        ? uiText.waiting
        : uiText.preparing);
  peer.textContent = value.peerName || uiText.app;
  invite.textContent = value.inviteUrl ? uiText.saved : "";
  invite.href = "#";
  invite.hidden = !value.inviteUrl;
  disconnectButton.hidden = !value.canDisconnect;
  const busy = operationBusy.val || value.transfer !== null;
  connectButton.disabled = busy || value.state === "booting" || value.state === "error";
  createButton.disabled = busy || value.state === "booting" || value.state === "error";
  sendButton.disabled = busy || !value.canSend || !textDraft.val.trim();
  fileButton.disabled = busy || !value.canSend;
  cancelButton.hidden = value.transfer === null;
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
fileButton.addEventListener("click", () => fileInput.click());
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
createButton.addEventListener("click", () => void perform(() => backend.createInvite()));
disconnectButton.addEventListener("click", () => void run(() => backend.disconnect()));
settingsButton.addEventListener("click", () => {
  const activeElement = document.activeElement;
  settingsReturnFocus =
    activeElement && activeElement.nodeType === 1 ? (activeElement as HTMLElement) : settingsButton;
  if (typeof settingsDialog.showModal === "function") {
    settingsDialog.showModal();
  } else {
    settingsDialog.setAttribute("open", "");
  }
});
settingsDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSettings();
});
copyTextButton.addEventListener("click", () => {
  if (lastReceivedText.val) {
    void run(() => backend.copyText(lastReceivedText.val));
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
const popover = div(
  { id: "invite-popover", popover: "auto", class: "popover" },
  isJapanese ? "招待URLをコピーしました" : "Invitation copied",
);
document.body.append(settingsDialog, popover);
invite.addEventListener("click", (event) => {
  event.preventDefault();
  const inviteUrl = snapshot.val.inviteUrl;
  if (!inviteUrl) {
    return;
  }
  void run(async () => {
    await backend.copyText(inviteUrl);
    popover.showPopover?.();
    placeAnchor(invite, popover);
    window.setTimeout(() => popover.hidePopover?.(), 1200);
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
      div(
        { class: "connection-actions" },
        joinInput,
        connectButton,
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
