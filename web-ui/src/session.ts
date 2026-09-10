import { initialSnapshot } from './api/application-api';
import type { BackendEvent, BackendSnapshot, PonletBackend } from './api/application-api';
import { validateSnapshot } from './api/validation';

export interface Message { text: string; incoming: boolean }
export interface SessionView {
  snapshot: BackendSnapshot;
  messages: Message[];
  lastReceivedText: string;
}

/** Own event ordering independently of DOM rendering. Subscribe before reading
 * the snapshot so a delayed initial response cannot overwrite a newer event. */
export class Session {
  view: SessionView = { snapshot: initialSnapshot(), messages: [], lastReceivedText: '' };
  private sequence = -1;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(private backend: PonletBackend, private changed: (view: SessionView) => void) {}

  async start(): Promise<void> {
    if (this.disposed) return;
    try {
      this.unsubscribe = this.backend.subscribe((event) => {
        try { this.applyEvent(event); }
        catch (error) { this.reportError(error); }
      });
      this.applySnapshot(await this.backend.snapshot());
    } catch (error) { this.reportError(error); }
  }

  private applySnapshot(snapshot: BackendSnapshot): void {
    validateSnapshot(snapshot);
    if (this.disposed || snapshot.sequence < this.sequence) return;
    this.sequence = snapshot.sequence;
    this.view = { ...this.view, snapshot };
    this.changed(this.view);
  }

  applyEvent(event: BackendEvent): void {
    if (this.disposed) return;
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new Error('Invalid event sequence');
    if (event.sequence <= this.sequence) return;
    if (event.type === 'snapshot') {
      if (event.sequence !== event.snapshot.sequence) throw new Error('Inconsistent snapshot sequence');
      this.applySnapshot(event.snapshot);
      return;
    }
    this.sequence = event.sequence;
    let snapshot = { ...this.view.snapshot, sequence: event.sequence };
    if (event.type === 'text') {
      this.view = {
        ...this.view,
        messages: [{ text: event.text, incoming: event.incoming }, ...this.view.messages],
        lastReceivedText: event.incoming ? event.text : this.view.lastReceivedText,
      };
    } else if (event.type === 'progress' && snapshot.transfer?.id === event.id) {
      snapshot.transfer = { ...snapshot.transfer, done: event.done, total: event.total };
    } else if (event.type === 'terminal' && snapshot.transfer?.id === event.id) {
      snapshot = { ...snapshot, transfer: null, canSend: false,
        error: event.status === 'failed' ? event.message ?? 'Transfer failed' : null };
      // Connection state/capabilities belong to the backend. Refresh them
      // instead of inventing a connected state for stale terminal events.
      void this.refresh();
    }
    this.view = { ...this.view, snapshot };
    this.changed(this.view);
  }

  private async refresh(): Promise<void> {
    try { this.applySnapshot(await this.backend.snapshot()); }
    catch (error) { this.reportError(error); }
  }

  reportError(error: unknown): void {
    if (this.disposed) return;
    const message = error && typeof error === 'object' && 'message' in error
      ? String(error.message) : String(error);
    this.view = { ...this.view, snapshot: { ...this.view.snapshot, error: message } };
    this.changed(this.view);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try { this.unsubscribe?.(); }
    finally { await this.backend.dispose(); }
  }
}
