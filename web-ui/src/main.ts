import van from "vanjs-core";
import { createBackend, initializeBrowserBackend } from "@backend";
import {
  initialSnapshot,
  type PonletBackend,
  type ReceivedItem,
  type SharedPendingItem,
} from "./api/application-api";
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
const activeTab = van.state<"transfer" | "messages">("transfer");
const connectionMode = van.state<"qr" | "join">("qr");
const messageMenuOpen = van.state<string | null>(null);
const chatMenuOpen = van.state(false);
const operationBusy = van.state(false);
let session: Session | undefined;
let starting: Promise<void> | undefined;
let sharedImportInFlight: Promise<void> | undefined;
let wasConnected = false;
let viewedMessageCount = 0;
const viewportWidth = van.state(window.innerWidth);
const now = van.state(Date.now());
const pendingShares = van.state<Array<SharedPendingItem>>([]);
let inviteUrl = "";
let inviteDeadline = 0;
const clock = window.setInterval(() => {
  now.val = Date.now();
}, 1000);

function updateViewportMetrics(): void {
  viewportWidth.val = window.innerWidth;
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--viewport-height", `${height}px`);
}
window.addEventListener("resize", updateViewportMetrics, { passive: true });
window.visualViewport?.addEventListener("resize", updateViewportMetrics, { passive: true });
updateViewportMetrics();

function createSession(): Session {
  return new Session(getBackend(), (view) => {
    const previouslyIdle = snapshot.val.state === "connected";
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
    if (view.snapshot.state === "connected" && !previouslyIdle) {
      importSharedItems();
    }
  });
}

function importSharedItems(): void {
  const current = backend;
  if (!current?.importShared || sharedImportInFlight) {
    return;
  }
  const task = current
    .importShared()
    .then((summary) => {
      if (current === backend) {
        pendingShares.val = summary.pendingItems;
      }
    })
    .catch((error) => {
      if (current === backend) {
        session?.reportError(error);
      }
    });
  sharedImportInFlight = task;
  void task.finally(() => {
    if (sharedImportInFlight === task) {
      sharedImportInFlight = undefined;
    }
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
window.addEventListener("focus", () => importSharedItems());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    importSharedItems();
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
  return [...messages.val]
    .reverse()
    .map((message) => `${message.incoming ? "[Peer]" : "[Me]"}: ${message.text}`)
    .join("\n");
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
const connectionInfoButton = button(
  {
    class: "icon-button connection-info-button",
    type: "button",
    "aria-label": () => uiText.connectionDetails,
  },
  "ⓘ",
);
const connectionInfoPeer = p({ class: "connection-info-peer" });
const connectionInfoRoute = p({ class: "connection-info-route" });
const connectionInfoClose = button({ class: "secondary", type: "button" }, () => uiText.close);
const connectionInfoPanel = div(
  { class: "connection-info-panel", hidden: true, role: "dialog" },
  connectionInfoPeer,
  connectionInfoRoute,
  connectionInfoClose,
);
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
const sendButton = button(
  { class: "primary composer-send", type: "button", "aria-label": () => uiText.send },
  "➤",
);
const fileButton = button({ class: "secondary", type: "button" }, () => uiText.chooseFile);
const fileInput = input({
  type: "file",
  multiple: true,
  hidden: true,
  "aria-label": () => uiText.fileInputAriaLabel,
});
const textInput = textarea({
  class: "composer",
  rows: 1,
  placeholder: () => uiText.message,
  "aria-label": () => uiText.messageInputAriaLabel,
  spellcheck: "true",
});
const pasteButton = button(
  { class: "secondary composer-paste", type: "button", "aria-label": () => uiText.paste },
  "📋",
);
const clearDraftButton = button({ class: "secondary", type: "button" }, () => uiText.clearDraft);
const clearHistoryButton = button(
  { class: "secondary", type: "button" },
  () => uiText.clearHistory,
);
const copyTextButton = button({ class: "secondary", type: "button" }, () => uiText.copy);
const shareTextButton = button({ class: "secondary", type: "button" }, () => uiText.share);
const saveTextButton = button({ class: "secondary", type: "button" }, () => uiText.save);
const chatMoreButton = button(
  { class: "icon-button chat-more-button", type: "button", "aria-label": () => uiText.chatActions },
  "⋯",
);
const historyMenu = div(
  { class: "chat-menu", hidden: true },
  copyTextButton,
  shareTextButton,
  saveTextButton,
  clearHistoryButton,
  clearDraftButton,
);
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
const qrModeButton = button(
  { class: "connection-mode-button", type: "button", role: "tab", id: "qr-mode-tab" },
  () => uiText.showQr,
);
const joinModeButton = button(
  { class: "connection-mode-button", type: "button", role: "tab", id: "join-mode-tab" },
  () => uiText.joinPeer,
);
const connectionModeSwitch = div(
  { class: "connection-mode-switch", role: "tablist" },
  qrModeButton,
  joinModeButton,
);
const qrPane = div(
  {
    class: "invite-pane qr-pane",
    role: "tabpanel",
    id: "qr-pane",
    "aria-labelledby": "qr-mode-tab",
  },
  qrView.container,
  expiry,
  invite,
  createButton,
);
const joinPane = div(
  {
    class: "invite-pane join-pane",
    role: "tabpanel",
    id: "join-pane",
    "aria-labelledby": "join-mode-tab",
  },
  joinInput,
  div({ class: "join-actions" }, pasteJoinButton, scanButton, connectButton),
);
const inviteArea = div(
  { class: "invite-area" },
  connectionModeSwitch,
  div({ class: "invite-mode-panes" }, qrPane, joinPane),
);
const pendingSharesCount = span({ class: "pending-shares-count" });
const pendingSharesList = ul({ class: "pending-shares-list" });
const pendingSharesCard = section(
  { class: "pending-shares-card", hidden: true, "aria-live": "polite" },
  div(
    { class: "pending-shares-heading" },
    h2(() => uiText.pendingShares),
    pendingSharesCount,
  ),
  p({ class: "pending-shares-hint" }, () => uiText.pendingSharesHint),
  pendingSharesList,
);
const transferBadge = span({ class: "tab-badge", hidden: true });
const messagesBadge = span({ class: "tab-badge", hidden: true });
const transferTabButton = button(
  {
    class: "workspace-tab",
    type: "button",
    role: "tab",
    id: "transfer-tab",
    "aria-controls": "transfer-panel",
  },
  span({ class: "tab-label" }, () => uiText.transfer),
  transferBadge,
);
const messagesTabButton = button(
  {
    class: "workspace-tab",
    type: "button",
    role: "tab",
    id: "messages-tab",
    "aria-controls": "messages-panel",
  },
  span({ class: "tab-label" }, () => uiText.messages),
  messagesBadge,
);
const workspaceTabs = div(
  { class: "workspace-tabs", role: "tablist", "aria-label": () => uiText.workspaceTabs },
  transferTabButton,
  messagesTabButton,
);
const connectionHeader = div(
  { class: "connection-header" },
  div({ class: "connection-status-row" }, status, transport, retryButton),
  div({ class: "connection-peer-row" }, peer, connectionInfoButton, disconnectButton),
);
const connectionCard = section(
  { class: "connection-card" },
  connectionHeader,
  connectionInfoPanel,
  inviteArea,
  pendingSharesCard,
);
const transferCard = section(
  {
    class: "transfer-card",
    id: "transfer-panel",
    role: "tabpanel",
    "aria-labelledby": "transfer-tab",
  },
  div(
    { class: "panel-heading" },
    h2(() => uiText.transfer),
  ),
  div({ class: "transfer-row" }, fileButton, fileInput),
  transferDetails,
  div(
    { class: "received-heading" },
    h2(() => uiText.receivedFiles),
    downloadsButton,
  ),
  receivedList,
);
const chatCard = section(
  {
    class: "chat-card",
    id: "messages-panel",
    role: "tabpanel",
    "aria-labelledby": "messages-tab",
  },
  div(
    { class: "panel-heading chat-heading" },
    h2(() => uiText.messages),
    div({ class: "chat-menu-wrap" }, chatMoreButton, historyMenu),
  ),
  log,
  div(
    { class: "composer-row" },
    pasteButton,
    label({ class: "composer-label" }, textInput),
    sendButton,
  ),
);
const workspace = section(
  { class: "workspace", hidden: true },
  workspaceTabs,
  div({ class: "workspace-panels" }, transferCard, chatCard),
);

function isTouchLayout(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches === true || window.innerWidth < 600;
}

function updateComposerHeight(): void {
  textInput.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(textInput).maxHeight);
  const height = Math.min(textInput.scrollHeight, Number.isFinite(maxHeight) ? maxHeight : 128);
  textInput.style.height = `${height}px`;
  textInput.style.overflowY = textInput.scrollHeight > height ? "auto" : "hidden";
}

function messageKey(message: Message, index: number): string {
  return `${message.sequence ?? "message"}-${message.incoming ? "in" : "out"}-${index}`;
}

function messageAction(action: "copy" | "share" | "save", message: Message): void {
  void run(async () => {
    if (action === "copy") {
      await getBackend().copyText(message.text);
      showToast(uiText.copiedMessage);
    } else if (action === "share") {
      await getBackend().shareText(message.text);
    } else {
      await getBackend().saveText(message.text);
    }
    messageMenuOpen.val = null;
  });
}

van.derive(() => {
  document.documentElement.lang = language.val;
  const value = snapshot.val;
  const remaining = Math.max(0, Math.ceil((inviteDeadline - now.val) / 1000));
  const expired = Boolean(value.inviteUrl) && remaining === 0;
  const active = value.transfer;
  const connected =
    value.state === "connected" || value.state === "transferring" || Boolean(active);
  const isWide = viewportWidth.val >= 768;
  if (connected !== wasConnected) {
    activeTab.val = "transfer";
    if (!connected) {
      connectionMode.val = "qr";
    }
    viewedMessageCount = messages.val.length;
    messageMenuOpen.val = null;
    chatMenuOpen.val = false;
    wasConnected = connected;
  }
  workspace.hidden = !connected;
  connectionCard.classList.toggle("is-connected", connected);
  inviteArea.hidden = connected;
  pendingSharesCard.hidden = connected || pendingShares.val.length === 0;
  pendingSharesCount.textContent = String(pendingShares.val.length);
  if (!connected) {
    connectionInfoPanel.hidden = true;
  }
  historyMenu.hidden = !chatMenuOpen.val;
  connectionModeSwitch.hidden = connected || isWide;
  qrPane.classList.toggle("is-active", isWide || connectionMode.val === "qr");
  joinPane.classList.toggle("is-active", isWide || connectionMode.val === "join");
  qrModeButton.classList.toggle("active", connectionMode.val === "qr");
  joinModeButton.classList.toggle("active", connectionMode.val === "join");
  qrModeButton.setAttribute("aria-selected", String(connectionMode.val === "qr"));
  joinModeButton.setAttribute("aria-selected", String(connectionMode.val === "join"));
  transferTabButton.classList.toggle("active", activeTab.val === "transfer");
  messagesTabButton.classList.toggle("active", activeTab.val === "messages");
  transferTabButton.setAttribute("aria-selected", String(activeTab.val === "transfer"));
  messagesTabButton.setAttribute("aria-selected", String(activeTab.val === "messages"));
  transferCard.hidden = !connected || activeTab.val !== "transfer";
  chatCard.hidden = !connected || activeTab.val !== "messages";
  transferCard.setAttribute("aria-hidden", String(!connected || activeTab.val !== "transfer"));
  chatCard.setAttribute("aria-hidden", String(!connected || activeTab.val !== "messages"));
  if (activeTab.val === "messages") {
    viewedMessageCount = messages.val.length;
  }
  const unreadMessages = Math.max(0, messages.val.length - viewedMessageCount);
  messagesBadge.hidden = unreadMessages === 0 || activeTab.val === "messages";
  messagesBadge.textContent = unreadMessages > 99 ? "99+" : String(unreadMessages);
  const transferNotice = Boolean(active) || Boolean(lastTransfer.val);
  transferBadge.hidden = !transferNotice || activeTab.val === "transfer";
  transferBadge.textContent = active ? "•" : "1";
  // Reading the clock updates expiry without issuing another QR request every second.
  expiry.hidden = !value.inviteUrl;
  expiry.classList.toggle("expired", expired);
  expiry.textContent = expired
    ? uiText.expired
    : `${uiText.expires}: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  const stateClass =
    value.error || expired
      ? "error"
      : connected
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
  const route = transportLabel(value.transport);
  transport.textContent =
    value.transport === "unknown" ? route : `${uiText.transportObserved}: ${route}`;
  transport.title = uiText.transportHint;
  transport.setAttribute("aria-label", `${uiText.transportObserved}: ${route}`);
  transport.hidden = !connected;
  peer.textContent = value.peerName || uiText.peer;
  peer.title = value.peerName || uiText.peer;
  peer.hidden = !connected;
  connectionInfoButton.hidden = !connected;
  connectionInfoPeer.textContent = `${uiText.peer}: ${value.peerName || uiText.peer}`;
  connectionInfoRoute.textContent = `${uiText.transportObserved}: ${route}\n${uiText.transportHint}`;
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
  copyTextButton.disabled =
    shareTextButton.disabled =
    saveTextButton.disabled =
      messages.val.length === 0;
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
function renderPendingShare(item: SharedPendingItem): HTMLElement {
  const kind = item.kind === "text" ? uiText.pendingText : uiText.pendingFile;
  const preview = item.preview ? p({ class: "pending-share-item-preview" }, item.preview) : null;
  return li(
    { class: "pending-share-item" },
    div(
      { class: "pending-share-item-meta", title: item.name },
      span({ class: "pending-share-item-kind" }, kind),
      span({ class: "pending-share-item-name" }, item.name),
      span({ class: "pending-share-item-size" }, formatBytes(item.size)),
    ),
    ...(preview ? [preview] : []),
  );
}
van.derive(() => {
  pendingSharesList.replaceChildren(...pendingShares.val.map(renderPendingShare));
});
let renderedReceived: Array<ReceivedItem> | undefined;
let receivedSharing = false;
van.derive(() => {
  const items = snapshot.val.received;
  const canShare = Boolean(backend?.shareReceivedItem);
  if (
    renderedReceived &&
    receivedSharing === canShare &&
    items.length === renderedReceived.length &&
    items.every((item, index) => {
      const previous = renderedReceived![index];
      return (
        item.name === previous.name &&
        item.size === previous.size &&
        item.localPathOrHandle === previous.localPathOrHandle
      );
    })
  ) {
    return;
  }
  // Preserve focused actions across progress/transport snapshots with unchanged files.
  renderedReceived = items.map((item) => ({ ...item }));
  receivedSharing = canShare;
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
      const shareButton = canShare
        ? button({ class: "secondary", type: "button" }, () => uiText.share)
        : undefined;
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
      shareButton?.addEventListener(
        "click",
        () => void run(() => getBackend().shareReceivedItem!(item)),
      );
      return li(
        { class: "received-item" },
        div(
          { class: "received-item-meta", title: item.name },
          item.name,
          span({ class: "received-item-size" }, formatBytes(item.size)),
        ),
        div(
          { class: "received-item-actions" },
          openButton,
          ...(shareButton ? [shareButton] : []),
          pathButton,
        ),
      );
    }),
  );
});
van.derive(() => {
  const previousHeight = log.scrollHeight;
  const previousTop = log.scrollTop;
  const atNewest = previousTop + log.clientHeight >= previousHeight - 24;
  const items = [...messages.val].reverse();
  log.replaceChildren(
    ...(items.length
      ? items.map((message, index) => {
          const key = messageKey(message, index);
          const actionButton = button(
            {
              class: "message-menu-button",
              type: "button",
              "aria-label": () => uiText.messageActions,
              "aria-expanded": () => String(messageMenuOpen.val === key),
            },
            "⋯",
          );
          const copyMessageButton = button(
            { class: "secondary", type: "button" },
            () => uiText.copy,
          );
          const shareMessageButton = button(
            { class: "secondary", type: "button" },
            () => uiText.share,
          );
          const saveMessageButton = button(
            { class: "secondary", type: "button" },
            () => uiText.save,
          );
          const actionMenu = div(
            { class: "message-menu", hidden: () => messageMenuOpen.val !== key },
            copyMessageButton,
            shareMessageButton,
            saveMessageButton,
          );
          copyMessageButton.addEventListener("click", () => messageAction("copy", message));
          shareMessageButton.addEventListener("click", () => messageAction("share", message));
          saveMessageButton.addEventListener("click", () => messageAction("save", message));
          actionButton.addEventListener("click", (event) => {
            event.stopPropagation();
            messageMenuOpen.val = messageMenuOpen.val === key ? null : key;
          });
          const bubble = p(
            { class: `message-bubble ${message.incoming ? "incoming" : "outgoing"}` },
            span({ class: "message-text" }, message.text),
          );
          return div(
            { class: `message-row ${message.incoming ? "incoming" : "outgoing"}` },
            bubble,
            actionButton,
            actionMenu,
          );
        })
      : [
          div(
            { class: "empty-state" },
            p({ class: "empty-state-title" }, () => uiText.noMessages),
            p({ class: "empty-state-hint" }, () => uiText.noMessagesHint),
          ),
        ]),
  );
  // Messages are rendered oldest first. Keep an older reading position when new items arrive.
  log.scrollTop = atNewest ? log.scrollHeight : Math.max(0, previousTop);
});
textInput.addEventListener("input", () => {
  textDraft.val = textInput.value;
  updateComposerHeight();
});
textInput.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !isTouchLayout()
  ) {
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
        updateComposerHeight();
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
      updateComposerHeight();
      textInput.focus();
    }),
);
clearDraftButton.addEventListener("click", () => {
  textDraft.val = "";
  textInput.value = "";
  updateComposerHeight();
  chatMenuOpen.val = false;
  textInput.focus();
});
clearHistoryButton.addEventListener("click", () => {
  session?.clearHistory();
  chatMenuOpen.val = false;
  showToast(uiText.historyCleared);
});

function selectWorkspaceTab(tab: "transfer" | "messages"): void {
  const hadUnreadMessages = tab === "messages" && messages.val.length > viewedMessageCount;
  activeTab.val = tab;
  messageMenuOpen.val = null;
  chatMenuOpen.val = false;
  if (tab === "messages") {
    viewedMessageCount = messages.val.length;
    if (hadUnreadMessages) {
      window.setTimeout(() => {
        log.scrollTop = log.scrollHeight;
      }, 0);
    }
  }
}
transferTabButton.addEventListener("click", () => selectWorkspaceTab("transfer"));
messagesTabButton.addEventListener("click", () => selectWorkspaceTab("messages"));
function moveTab(event: KeyboardEvent): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  const next: "transfer" | "messages" =
    event.key === "Home"
      ? "transfer"
      : event.key === "End"
        ? "messages"
        : event.key === "ArrowLeft"
          ? "transfer"
          : "messages";
  selectWorkspaceTab(next);
  (next === "transfer" ? transferTabButton : messagesTabButton).focus();
}
transferTabButton.addEventListener("keydown", moveTab);
messagesTabButton.addEventListener("keydown", moveTab);
qrModeButton.addEventListener("click", () => {
  connectionMode.val = "qr";
});
joinModeButton.addEventListener("click", () => {
  connectionMode.val = "join";
  joinInput.focus();
});
chatMoreButton.addEventListener("click", (event) => {
  event.stopPropagation();
  chatMenuOpen.val = !chatMenuOpen.val;
});
connectionInfoButton.addEventListener("click", (event) => {
  event.stopPropagation();
  connectionInfoPanel.hidden = !connectionInfoPanel.hidden;
});
connectionInfoClose.addEventListener("click", () => {
  connectionInfoPanel.hidden = true;
});
document.addEventListener("click", (event) => {
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== "function") {
    return;
  }
  if (!target.closest(".chat-menu-wrap")) {
    chatMenuOpen.val = false;
  }
  if (!target.closest(".message-row")) {
    messageMenuOpen.val = null;
  }
  if (!target.closest(".connection-info-panel, .connection-info-button")) {
    connectionInfoPanel.hidden = true;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    chatMenuOpen.val = false;
    messageMenuOpen.val = null;
    connectionInfoPanel.hidden = true;
  }
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
      chatMenuOpen.val = false;
      showToast(uiText.copiedMessage);
    });
  }
});
shareTextButton.addEventListener("click", () => {
  const text = exportText();
  if (text) {
    void run(async () => {
      await getBackend().shareText(text);
      chatMenuOpen.val = false;
    });
  }
});
saveTextButton.addEventListener("click", () => {
  const text = exportText();
  if (text) {
    void run(async () => {
      await getBackend().saveText(text);
      chatMenuOpen.val = false;
    });
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
const settingsLinks = div(
  { class: "settings-links" },
  externalLink(
    () => `https://ponlet.mat2uken.app/privacy_${language.val}.html`,
    () => uiText.privacy,
  ),
  externalLink(
    () => "https://ponlet.mat2uken.app/licenses.html",
    () => uiText.licenses,
  ),
);
const settingsCloseButton = settings.dialog.querySelector(".dialog-close");
if (settingsCloseButton) {
  settings.dialog.insertBefore(settingsLinks, settingsCloseButton);
} else {
  settings.dialog.append(settingsLinks);
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
    div({ class: "topbar-actions" }, settingsButton),
  ),
  main({ class: "shell" }, connectionCard, workspace),
  footer(
    { class: "footer" },
    p(() => uiText.footer),
  ),
);
updateComposerHeight();
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
      importSharedItems();
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
