/**
 * OPFS staging adapter used by the Dedicated Worker.  The transfer engine
 * owns the byte count and calls `write` with the received Uint8Array view;
 * this adapter never accumulates the file in a JS array or in the UI.
 */

export const OPFS_STAGING_DIRECTORY = ".ponlet-incomplete";
export const OPFS_COMPLETE_SUFFIX = ".complete";

interface OpfsWritable {
  abort(): Promise<void>;
  close(): Promise<void>;
  write(data: unknown): Promise<void>;
}

interface OpfsFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
  move?: (name: string) => Promise<void>;
}

interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface StorageWithOpfs {
  getDirectory?: () => Promise<OpfsDirectoryHandle>;
}

export interface OpfsReceivedItem {
  handleName: string;
  name: string;
  size: number;
}

export interface OpfsSink {
  abort(): Promise<void>;
  commit(): Promise<OpfsReceivedItem>;
  write(chunk: Uint8Array): Promise<void>;
}

function sanitizeFileName(name: string): string {
  const cleaned = Array.from(name.replaceAll(/[\\/:*?"<>|]/g, "_"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? "_" : character;
  })
    .join("")
    .trim()
    .replace(/^\.+$/, "_");
  return cleaned || "received.bin";
}

function getStorage(): StorageWithOpfs {
  return (globalThis.navigator as Navigator & { storage?: StorageWithOpfs }).storage ?? {};
}

/** Open a bounded OPFS sink.  Callers must commit only after the declared
 * size has been written; every other exit path should call abort. */
export async function openOpfsSink(name: string, expectedSize: number): Promise<OpfsSink> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error("invalid OPFS file size");
  }
  const storage = getStorage();
  if (!storage.getDirectory) {
    throw new Error("OPFS is unavailable");
  }
  const root = await storage.getDirectory();
  const staging = await root.getDirectoryHandle(OPFS_STAGING_DIRECTORY, { create: true });
  const safeName = sanitizeFileName(name);
  const token = crypto.randomUUID();
  // The display name can be arbitrarily long. Only the fixed-length token is
  // used for OPFS entries, so it cannot exceed a filesystem component limit.
  const stagingName = `${token}.part`;
  const completeName = `${token}${OPFS_COMPLETE_SUFFIX}`;
  const file = await staging.getFileHandle(stagingName, { create: true });
  let writable: OpfsWritable;
  try {
    writable = await file.createWritable({ keepExistingData: false });
  } catch (error) {
    await staging.removeEntry(stagingName).catch(() => undefined);
    throw error;
  }
  let written = 0;
  let accepting = true;
  let cancelled = false;
  let committed = false;
  let failed = false;
  let writerClosed = false;
  let entryName = stagingName;
  let queue = Promise.resolve();
  let cleanup: Promise<void> | null = null;

  function cleanupPartial(): Promise<void> {
    return (cleanup ??= (async () => {
      try {
        if (!writerClosed) {
          await writable.abort();
        }
      } finally {
        await staging.removeEntry(entryName);
      }
    })());
  }

  function assertOpen(): void {
    if (cancelled || failed || committed) {
      throw new Error("OPFS sink is closed");
    }
  }

  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    try {
      assertOpen();
      return await action();
    } catch (error) {
      accepting = false;
      failed = true;
      // Preserve the write/commit failure while still attempting cleanup.
      await cleanupPartial().catch(() => undefined);
      throw error;
    }
  }

  return {
    write(chunk: Uint8Array): Promise<void> {
      if (!accepting) {
        return Promise.reject(new Error("OPFS sink is closed"));
      }
      return enqueue(() =>
        guarded(async () => {
          if (written + chunk.byteLength > expectedSize) {
            throw new Error("OPFS sink received more bytes than declared");
          }
          // Callers retain the transferred buffer until this Promise settles.
          await writable.write({ type: "write", position: written, data: chunk });
          assertOpen();
          written += chunk.byteLength;
        }),
      );
    },
    commit(): Promise<OpfsReceivedItem> {
      if (!accepting) {
        return Promise.reject(new Error("OPFS sink is closed"));
      }
      accepting = false;
      return enqueue(() =>
        guarded(async () => {
          if (written !== expectedSize) {
            throw new Error(`OPFS size mismatch: expected ${expectedSize}, got ${written}`);
          }
          if (!file.move) {
            throw new Error("OPFS move is unavailable");
          }
          await writable.close();
          writerClosed = true;
          assertOpen();
          await file.move(completeName);
          entryName = completeName;
          assertOpen();
          committed = true;
          return { name: safeName, size: expectedSize, handleName: completeName };
        }),
      );
    },
    abort(): Promise<void> {
      if (committed) {
        return Promise.resolve();
      }
      // Set the flag immediately so an in-flight write/close cannot commit.
      cancelled = true;
      accepting = false;
      return enqueue(cleanupPartial);
    },
  };
}
