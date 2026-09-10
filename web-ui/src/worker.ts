/** Protocol types for the future Rust/OPFS worker. Creating the Worker,
 * dispatching these commands, and enforcing credits are not implemented yet.
 * File bytes use Transferable ArrayBuffers. */
export type TransferWorkerCommand =
  | { type: "init"; sessionId: string; credits: number }
  | {
      type: "chunk";
      transferId: string;
      slot: number;
      buffer: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
    }
  | { type: "cancel"; transferId: string };

export type TransferWorkerEvent =
  | { type: "need-chunk"; transferId: string; slot: number; maxLength: number }
  | {
      type: "chunk-written";
      transferId: string;
      slot: number;
      buffer: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
    }
  | {
      type: "terminal";
      transferId: string;
      status: "completed" | "cancelled" | "failed";
      message?: string;
    };

export const MAX_IN_FLIGHT_CHUNKS = 2;
export const CHUNK_SIZE = 64 * 1024;

export { openOpfsSink, OPFS_COMPLETE_SUFFIX, OPFS_STAGING_DIRECTORY } from "./opfs";

export function postChunk(
  port: MessagePort,
  command: Extract<TransferWorkerCommand, { type: "chunk" }>,
): void {
  port.postMessage(command, [command.buffer]);
}
