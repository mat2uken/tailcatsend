/**
 * Stable JavaScript surface consumed by the Rust/Slint WebAssembly adapter.
 * The implementation wraps Tailcat's Go WASM globals.
 */

export type TailcatWebErrorCode =
  | "invalid_argument"
  | "timeout"
  | "cancelled"
  | "closed"
  | "network"
  | "internal";

export interface TailcatWebError extends Error {
  code: TailcatWebErrorCode;
}

export interface TailcatListenOptions {
  derpMapUrl: string;
  /** P0 leaves this undefined to create an ephemeral key. */
  privateKeyJson?: string;
  verbose?: boolean;
  signal?: AbortSignal;
}

export interface TailcatDialOptions {
  address: string;
  derpMapUrl: string;
  port: number;
  /** P0 leaves this undefined to use the current ephemeral peer identity. */
  privateKeyJson?: string;
  timeoutMs?: number;
  verbose?: boolean;
  signal?: AbortSignal;
}

export interface TailcatIncomingStream {
  stream: TailcatWebStream;
  port: number;
}

export interface TailcatWebListener {
  readonly address: string;
  /**
   * Returns the next incoming stream, or null when the listener has closed.
   * Concurrent calls are forbidden.
   */
  nextIncoming(signal?: AbortSignal): Promise<TailcatIncomingStream | null>;
  close(): void;
}

export interface TailcatWebStream {
  readonly port: number;
  /** Pull-based. Returns null on orderly EOF. Concurrent reads are forbidden. */
  read(signal?: AbortSignal): Promise<Uint8Array | null>;
  /** Resolves only after Tailcat accepted/copied the complete chunk. */
  write(data: Uint8Array, signal?: AbortSignal): Promise<void>;
  closeWrite(): Promise<void>;
  close(): void;
}

export interface TailcatWebBridge {
  readonly bridgeVersion: string;
  listen(options: TailcatListenOptions): Promise<TailcatWebListener>;
  dial(options: TailcatDialOptions): Promise<TailcatWebStream>;
  shutdown(): Promise<void>;
}

declare global {
  interface Window {
    tailSendTailcat: TailcatWebBridge;
  }
}

export {};
