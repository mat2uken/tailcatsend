import { initialSnapshot } from "./api/application-api";
import type { BackendEvent, BackendSnapshot, PonletBackend } from "./api/application-api";
import { validateSnapshot } from "./api/validation";

export interface Message {
  incoming: boolean;
  sequence?: number;
  text: string;
}
export interface TransferResult {
  done: number;
  id: string;
  incoming: boolean;
  message?: string;
  name: string;
  status: "completed" | "cancelled" | "failed";
  total: number;
}
export interface SessionView {
  lastReceivedText: string;
  lastTransfer: TransferResult | null;
  messages: Array<Message>;
  snapshot: BackendSnapshot;
  transferBytesPerSecond: number;
}

/** Own event ordering independently of DOM rendering. Subscribe before reading
 * the snapshot so a delayed initial response cannot overwrite a newer event. */
export class Session {
  view: SessionView = {
    snapshot: initialSnapshot(),
    messages: [],
    lastReceivedText: "",
    lastTransfer: null,
    transferBytesPerSecond: 0,
  };
  private sequence = -1;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private historyClearedAt = -1;
  private dismissedTransfers = new Set<string>();
  private transfers = new Map<
    string,
    { transfer: NonNullable<BackendSnapshot["transfer"]>; startedAt: number; initialBytes: number }
  >();

  private rememberTransfer(transfer: BackendSnapshot["transfer"]): void {
    if (!transfer) {
      return;
    }
    const previous = this.transfers.get(transfer.id);
    const sample = previous ?? { transfer, startedAt: Date.now(), initialBytes: transfer.done };
    sample.transfer = transfer;
    this.transfers.set(transfer.id, sample);
    if (this.transfers.size > 32) {
      this.transfers.delete(this.transfers.keys().next().value!);
    }
    const elapsed = (Date.now() - sample.startedAt) / 1000;
    this.view = {
      ...this.view,
      transferBytesPerSecond:
        elapsed > 0 ? Math.max(0, transfer.done - sample.initialBytes) / elapsed : 0,
    };
  }

  recordSentText(
    text: string,
    previousMessages: ReadonlyArray<Message> = this.view.messages,
  ): void {
    // Some injected adapters report outgoing events; native and Rust/WASM only
    // report incoming text. Add a local entry only after successful delivery.
    if (
      this.view.messages.some(
        (message) =>
          !message.incoming && message.text === text && !previousMessages.includes(message),
      )
    ) {
      return;
    }
    this.view = {
      ...this.view,
      messages: [{ text, incoming: false, sequence: this.sequence }, ...this.view.messages],
    };
    this.changed(this.view);
  }

  clearHistory(): void {
    this.historyClearedAt = this.sequence;
    this.view = { ...this.view, messages: [], lastReceivedText: "" };
    this.changed(this.view);
  }

  dismissTransfer(): void {
    if (this.view.lastTransfer) {
      this.dismissedTransfers.add(this.view.lastTransfer.id);
    }
    this.view = { ...this.view, lastTransfer: null };
    this.changed(this.view);
  }

  clearError(): void {
    this.view = { ...this.view, snapshot: { ...this.view.snapshot, error: null } };
    this.changed(this.view);
  }

  constructor(
    private backend: PonletBackend,
    private changed: (view: SessionView) => void,
  ) {}

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      this.unsubscribe = this.backend.subscribe((event) => {
        try {
          this.applyEvent(event);
        } catch (error) {
          this.reportError(error);
        }
      });
      this.applySnapshot(await this.backend.snapshot());
    } catch (error) {
      this.reportError(error);
    }
  }

  private applySnapshot(snapshot: BackendSnapshot): void {
    validateSnapshot(snapshot);
    if (this.disposed || snapshot.sequence < this.sequence) {
      return;
    }
    this.sequence = snapshot.sequence;
    const known = new Set(
      this.view.messages.filter((message) => message.incoming).map((message) => message.sequence),
    );
    const recovered = (snapshot.receivedMessages ?? []).filter(
      (message) => message.sequence > this.historyClearedAt && !known.has(message.sequence),
    );
    const messages = recovered.length
      ? [
          ...this.view.messages,
          ...recovered.map((message) => ({ ...message, incoming: true })),
        ].sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0))
      : this.view.messages;
    this.rememberTransfer(snapshot.transfer);
    const terminal = snapshot.lastTransfer;
    if (
      terminal &&
      (terminal.status === "completed" ||
        terminal.status === "cancelled" ||
        terminal.status === "failed")
    ) {
      if (!this.dismissedTransfers.has(terminal.id)) {
        this.view = {
          ...this.view,
          lastTransfer: {
            ...terminal,
            status: terminal.status,
            message: terminal.message ?? undefined,
          },
        };
      }
      this.transfers.delete(terminal.id);
    }
    this.view = {
      ...this.view,
      snapshot,
      messages,
      lastReceivedText: messages.find((message) => message.incoming)?.text ?? "",
    };
    this.changed(this.view);
  }

  applyEvent(event: BackendEvent): void {
    if (this.disposed) {
      return;
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new Error("Invalid event sequence");
    }
    if (event.sequence <= this.sequence) {
      return;
    }
    if (event.type === "snapshot") {
      if (event.sequence !== event.snapshot.sequence) {
        throw new Error("Inconsistent snapshot sequence");
      }
      this.applySnapshot(event.snapshot);
      return;
    }
    this.sequence = event.sequence;
    let snapshot = { ...this.view.snapshot, sequence: event.sequence };
    if (event.type === "text") {
      this.view = {
        ...this.view,
        messages: [
          { text: event.text, incoming: event.incoming, sequence: event.sequence },
          ...this.view.messages,
        ],
        lastReceivedText: event.incoming ? event.text : this.view.lastReceivedText,
      };
    } else if (event.type === "files") {
      snapshot.received = [...snapshot.received, ...event.items];
    } else if (event.type === "progress" && snapshot.transfer?.id === event.id) {
      snapshot.transfer = { ...snapshot.transfer, done: event.done, total: event.total };
      this.rememberTransfer(snapshot.transfer);
    } else if (event.type === "terminal") {
      const known = this.transfers.get(event.id);
      if (known && !this.dismissedTransfers.has(event.id)) {
        this.view = {
          ...this.view,
          lastTransfer: { ...known.transfer, status: event.status, message: event.message },
        };
      }
      this.transfers.delete(event.id);
      if (snapshot.transfer?.id !== event.id) {
        this.view = { ...this.view, snapshot };
        this.changed(this.view);
        return;
      }
      snapshot = {
        ...snapshot,
        transfer: null,
        canSend: false,
        error: event.status === "failed" ? (event.message ?? "Transfer failed") : null,
      };
      // Connection state/capabilities belong to the backend. Refresh them
      // instead of inventing a connected state for stale terminal events.
      void this.refresh();
    }
    this.view = { ...this.view, snapshot };
    this.changed(this.view);
  }

  private async refresh(): Promise<void> {
    try {
      this.applySnapshot(await this.backend.snapshot());
    } catch (error) {
      this.reportError(error);
    }
  }

  reportError(error: unknown): void {
    if (this.disposed) {
      return;
    }
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    this.view = { ...this.view, snapshot: { ...this.view.snapshot, error: message } };
    this.changed(this.view);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.unsubscribe?.();
    } finally {
      await this.backend.dispose();
    }
  }
}
