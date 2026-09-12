interface StorageLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

interface ReceivedDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ReceivedFile>;
  removeEntry(name: string): Promise<void>;
}

interface ReceivedWriter {
  abort(): Promise<void>;
  close(): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
}

interface SyncReceivedAccess {
  close(): void | Promise<void>;
  flush(): void | Promise<void>;
  truncate(size: number): void | Promise<void>;
  write(chunk: Uint8Array, options: { at: number }): number | Promise<number>;
}

interface ReceivedFile {
  createSyncAccessHandle?(): Promise<SyncReceivedAccess>;
  createWritable?(): Promise<ReceivedWriter>;
  getFile(): Promise<Blob>;
  move?(name: string): Promise<void>;
  readonly name: string;
}

// All Ponlet tabs/workers sharing OPFS must use this same lock name.
const RECEIVED_FILES_LOCK = "ponlet:opfs:Ponlet:commit";
const COPY_CHUNK_SIZE = 64 * 1024;

function errorName(error: unknown): unknown {
  return error && typeof error === "object" && "name" in error ? error.name : "";
}

/** Called only in the transfer worker, where sync OPFS handles are available. */
export async function createReceivedWriter(file: ReceivedFile): Promise<ReceivedWriter> {
  if (typeof file.createWritable === "function") {
    try {
      return await file.createWritable();
    } catch (error) {
      if (errorName(error) !== "NotSupportedError") {
        throw error;
      }
    }
  }
  if (typeof file.createSyncAccessHandle !== "function") {
    throw new Error("This browser does not support writing received files to OPFS");
  }
  const access = await file.createSyncAccessHandle();
  let closed = false;
  let offset = 0;
  const closeAccess = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await access.close();
    }
  };
  try {
    await access.truncate(0);
  } catch (error) {
    await closeAccess().catch(() => undefined);
    throw error;
  }
  return {
    abort: closeAccess,
    close: async () => {
      if (!closed) {
        try {
          await access.flush();
        } finally {
          await closeAccess();
        }
      }
    },
    write: async (chunk) => {
      if (closed) {
        throw new Error("Received file writer is closed");
      }
      let written = 0;
      while (written < chunk.byteLength) {
        const count = await access.write(chunk.subarray(written), { at: offset });
        if (!Number.isSafeInteger(count) || count <= 0 || count > chunk.byteLength - written) {
          throw new Error("OPFS could not write the complete file chunk");
        }
        written += count;
        offset += count;
      }
    },
  };
}

function numberedName(name: string, number: number): string {
  if (number === 0) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${number})${name.slice(dot)}` : `${name} (${number})`;
}

async function entryExists(directory: ReceivedDirectory, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (errorName(error) === "NotFoundError") {
      return false;
    }
    if (errorName(error) === "TypeMismatchError") {
      return true; // A directory with this name must also be preserved.
    }
    throw error;
  }
}

async function copyReceivedFile(
  directory: ReceivedDirectory,
  file: ReceivedFile,
  name: string,
): Promise<void> {
  const source = await file.getFile();
  // Caller holds the same origin-wide lock from the existence check through
  // this newly created destination's close. No existing entry is truncated.
  const destination = await directory.getFileHandle(name, { create: true });
  let writer: ReceivedWriter | undefined;
  try {
    writer = await createReceivedWriter(destination);
    for (let offset = 0; offset < source.size; offset += COPY_CHUNK_SIZE) {
      const buffer = await source.slice(offset, offset + COPY_CHUNK_SIZE).arrayBuffer();
      await writer.write(new Uint8Array(buffer));
    }
    await writer.close();
  } catch (error) {
    await writer?.abort().catch(() => undefined);
    await directory.removeEntry(name).catch(() => undefined);
    throw error;
  }
  // A failure to remove the temporary file must not report failure after a
  // completed, flushed copy. It cannot overwrite the received file.
  await directory.removeEntry(file.name).catch(() => undefined);
}

export async function commitReceivedFile(
  directory: ReceivedDirectory,
  file: ReceivedFile,
  name: string,
  locks: StorageLockManager | undefined = globalThis.navigator?.locks,
): Promise<string> {
  if (!locks?.request) {
    throw new Error("Safe file storage requires Web Locks support");
  }
  return locks.request(RECEIVED_FILES_LOCK, async () => {
    for (let number = 0; number < 10_000; number++) {
      const destination = numberedName(name, number);
      if (!(await entryExists(directory, destination))) {
        // move() may replace an existing file. Keep the lock until the move
        // finishes, not only while selecting its name.
        if (typeof file.move === "function") {
          try {
            await file.move(destination);
            return destination;
          } catch (error) {
            if (errorName(error) !== "NotSupportedError") {
              throw error;
            }
          }
        }
        // Safari/Firefox can persist OPFS files without exposing move().
        // Copy in bounded chunks entirely inside the worker.
        await copyReceivedFile(directory, file, destination);
        return destination;
      }
    }
    throw new Error("Too many files with the same received name");
  });
}
