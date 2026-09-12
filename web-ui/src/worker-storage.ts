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
  move?(directory: ReceivedDirectory, name: string): Promise<void>;
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
            // WebKit requires the directory+name form. Chromium supports it
            // too; the single-name overload is not portable.
            await file.move(directory, destination);
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

interface StorageRoot extends ReceivedDirectory {
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<ReceivedDirectory>;
}

interface WorkerStorage {
  getDirectory?(): Promise<StorageRoot>;
}

interface WorkerReceivedItem {
  localPathOrHandle: string;
  name: string;
  size: number;
}

interface WorkerReceivedSink {
  abort(): Promise<void>;
  commit(expectedSize: number): Promise<WorkerReceivedItem>;
  write(chunk: Uint8Array): Promise<void>;
}

interface PreparedReceive {
  cleanup(): Promise<void>;
  finish(size: number): Promise<WorkerReceivedItem>;
  writer: ReceivedWriter;
}

const receivedBlobUrls = new Set<string>();
const receivedBlobNames = new Set<string>();
const pendingReceives = new Set<() => Promise<void>>();
const pendingPreparations = new Set<Promise<WorkerReceivedSink>>();
let storageGeneration = 0;

function memoryReceive(name: string): PreparedReceive {
  // Blob snapshots each chunk before Rust reuses its transfer buffer. This
  // compatibility path retains the complete file in the worker, never the UI.
  const parts: Array<Blob> = [];
  const discard = async (): Promise<void> => {
    parts.length = 0;
  };
  return {
    cleanup: discard,
    finish: async (size) => {
      const blob = new Blob(parts, { type: "application/octet-stream" });
      if (blob.size !== size) {
        throw new Error("Received Blob size mismatch");
      }
      let number = 0;
      while (receivedBlobNames.has(numberedName(name, number))) {
        number++;
      }
      const savedName = numberedName(name, number);
      const url = URL.createObjectURL(blob);
      receivedBlobUrls.add(url);
      receivedBlobNames.add(savedName);
      parts.length = 0;
      return { name: savedName, size, localPathOrHandle: url };
    },
    writer: {
      abort: discard,
      close: async () => undefined,
      write: async (chunk) => {
        parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
      },
    },
  };
}

function managedReceive(prepared: PreparedReceive, generation: number): WorkerReceivedSink {
  let phase: "open" | "closing" | "completed" | "aborted" | "failed" = "open";
  let size = 0;
  let queue = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  const clean = (): Promise<void> => (cleanup ??= prepared.cleanup());
  const ensureLive = (): void => {
    if (generation !== storageGeneration || ["completed", "aborted", "failed"].includes(phase)) {
      throw new Error("Received file sink is closed");
    }
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      try {
        ensureLive();
        return await operation();
      } catch (error) {
        phase = "failed";
        try {
          await clean().catch(() => undefined);
        } finally {
          pendingReceives.delete(abort);
        }
        throw error;
      }
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const abort = (): Promise<void> => {
    if (phase === "completed") {
      return Promise.resolve();
    }
    phase = "aborted";
    return queue.then(clean).finally(() => pendingReceives.delete(abort));
  };
  pendingReceives.add(abort);
  return {
    abort,
    commit: (expectedSize) => {
      if (phase !== "open") {
        return Promise.reject(new Error("Received file sink is closed"));
      }
      phase = "closing";
      return enqueue(async () => {
        if (!Number.isSafeInteger(expectedSize) || size !== expectedSize) {
          throw new Error("Received file size mismatch");
        }
        await prepared.writer.close();
        ensureLive();
        const item = await prepared.finish(size);
        if (generation !== storageGeneration || phase !== "closing") {
          if (receivedBlobUrls.delete(item.localPathOrHandle)) {
            URL.revokeObjectURL(item.localPathOrHandle);
          }
          throw new Error("Received file sink is closed");
        }
        phase = "completed";
        pendingReceives.delete(abort);
        return item;
      });
    },
    write: (chunk) => {
      if (phase !== "open") {
        return Promise.reject(new Error("Received file sink is closed"));
      }
      return enqueue(async () => {
        await prepared.writer.write(chunk);
        ensureLive();
        size += chunk.byteLength;
      });
    },
  };
}

/** Select storage once, before any received bytes have been accepted. */
async function prepareReceive(
  name: string,
  storage: WorkerStorage | undefined = globalThis.navigator?.storage as WorkerStorage | undefined,
  locks: StorageLockManager | undefined = globalThis.navigator?.locks,
): Promise<WorkerReceivedSink> {
  const generation = storageGeneration;
  let temporaryName = "";
  let directory: ReceivedDirectory | undefined;
  let writer: ReceivedWriter | undefined;
  let file: ReceivedFile | undefined;
  const cleanup = async (): Promise<void> => {
    await writer?.abort().catch(() => undefined);
    if (file) {
      await directory?.removeEntry(temporaryName).catch(() => undefined);
    }
  };
  try {
    if (!storage?.getDirectory) {
      throw new Error("OPFS is unavailable");
    }
    const root = await storage.getDirectory();
    directory = await root.getDirectoryHandle("Ponlet", { create: true });
    temporaryName = `.ponlet-${crypto.randomUUID()}.part`;
    file = await directory.getFileHandle(temporaryName, { create: true });
    writer = await createReceivedWriter(file);
    if (generation !== storageGeneration) {
      throw new Error("Received file storage was disposed");
    }
  } catch (error) {
    await cleanup();
    if (generation !== storageGeneration) {
      throw error;
    }
    // Private browsing can expose OPFS but reject getDirectory with UnknownError.
    // Only preparation failures select memory; later I/O failures remain errors.
    return managedReceive(memoryReceive(name), generation);
  }
  const preparedDirectory = directory;
  const preparedFile = file;
  return managedReceive(
    {
      cleanup,
      finish: async (size) => {
        const savedName = await commitReceivedFile(preparedDirectory, preparedFile, name, locks);
        return { name: savedName, size, localPathOrHandle: `opfs:/Ponlet/${savedName}` };
      },
      writer,
    },
    generation,
  );
}

export function prepareReceivedFile(
  name: string,
  storage: WorkerStorage | undefined = globalThis.navigator?.storage as WorkerStorage | undefined,
  locks: StorageLockManager | undefined = globalThis.navigator?.locks,
): Promise<WorkerReceivedSink> {
  const operation = prepareReceive(name, storage, locks);
  pendingPreparations.add(operation);
  void operation.then(
    () => pendingPreparations.delete(operation),
    () => pendingPreparations.delete(operation),
  );
  return operation;
}

/** Normal disconnect preserves received files. Only backend disposal calls this. */
export async function disposeReceivedFiles(): Promise<void> {
  storageGeneration++;
  // A writer can finish opening after disposal starts. Wait for its generation
  // check and cleanup before the caller is allowed to terminate this worker.
  await Promise.allSettled([
    ...pendingPreparations,
    ...Array.from(pendingReceives, (abort) => abort()),
  ]);
  for (const url of receivedBlobUrls) {
    URL.revokeObjectURL(url);
  }
  receivedBlobUrls.clear();
  receivedBlobNames.clear();
}
