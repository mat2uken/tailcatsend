import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeReceivedFiles, prepareReceivedFile } from "../src/worker-storage.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function blobStore() {
  const blobs = new Map();
  let sequence = 0;
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:${location.origin}/received-${sequence++}`;
    blobs.set(url, blob);
    return url;
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    blobs.delete(url);
  });
  return { blobs, create, revoke };
}

const unavailableStorage = {
  async getDirectory() {
    // WebKit private contexts expose this method but deny OPFS access.
    throw new DOMException("Unable to get file system directory handle", "UnknownError");
  },
};

function opfsStorage({ fail, preparing, writing, moving, aborting } = {}) {
  const entries = new Map([["existing.bin", Uint8Array.of(9)]]);
  const openHandles = new Set();
  const removed = [];
  const writes = [];
  const failAt = (stage) => {
    if (fail === stage) {
      throw new DOMException(`${stage} failed`, "QuotaExceededError");
    }
  };
  const directory = {
    async getFileHandle(name, options) {
      if (!entries.has(name)) {
        if (!options?.create) {
          throw new DOMException("Missing", "NotFoundError");
        }
        entries.set(name, new Uint8Array());
      }
      let entryName = name;
      return {
        get name() {
          return entryName;
        },
        async createWritable() {
          if (preparing) {
            await preparing();
          }
          failAt("prepare");
          openHandles.add(entryName);
          return {
            async write(chunk) {
              if (writing) {
                await writing();
              }
              failAt("write");
              const old = entries.get(entryName);
              const result = new Uint8Array(old.byteLength + chunk.byteLength);
              result.set(old);
              result.set(chunk, old.byteLength);
              entries.set(entryName, result);
              writes.push(chunk.byteLength);
            },
            async close() {
              openHandles.delete(entryName);
              failAt("close");
            },
            async abort() {
              if (aborting) {
                await aborting();
              }
              openHandles.delete(entryName);
            },
          };
        },
        async getFile() {
          return new Blob([entries.get(entryName)]);
        },
        async move(destination, nextName) {
          // WebKit exposes only move(directory, newName), not move(newName).
          if (destination !== directory || typeof nextName !== "string") {
            throw new DOMException("Destination must be a directory", "TypeMismatchError");
          }
          if (moving) {
            await moving();
          }
          failAt("move");
          entries.set(nextName, entries.get(entryName));
          entries.delete(entryName);
          entryName = nextName;
        },
      };
    },
    async removeEntry(name) {
      removed.push(name);
      entries.delete(name);
    },
  };
  return {
    directory,
    entries,
    openHandles,
    removed,
    writes,
    locks: {
      async request(_name, callback) {
        return callback();
      },
    },
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle() {
            return directory;
          },
        };
      },
    },
  };
}

afterEach(async () => {
  await disposeReceivedFiles();
  vi.restoreAllMocks();
});

describe("worker receive storage selection", () => {
  it("receives in a worker Blob when private browsing rejects OPFS", async () => {
    const urls = blobStore();
    const sink = await prepareReceivedFile("received.bin", unavailableStorage, null);
    const chunk = Uint8Array.of(1, 2, 3);
    await sink.write(chunk);
    chunk.fill(8); // Rust may reuse a transfer buffer only after write resolves.
    await sink.write(Uint8Array.of(4, 5));
    const result = await sink.commit(5);
    expect(result).toEqual({
      name: "received.bin",
      size: 5,
      localPathOrHandle: `blob:${location.origin}/received-0`,
    });
    expect(Object.keys(result).sort()).toEqual(["localPathOrHandle", "name", "size"]);
    expect(new Uint8Array(await urls.blobs.get(result.localPathOrHandle).arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3, 4, 5),
    );
    await sink.abort(); // A completed receive survives an unrelated transfer cleanup.
    expect(urls.revoke).not.toHaveBeenCalled();
  });

  it("preserves simultaneous same-name Blob receives and releases their URLs on disposal", async () => {
    const urls = blobStore();
    const results = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const sink = await prepareReceivedFile("same.txt", unavailableStorage, null);
        await sink.write(Uint8Array.of(index));
        return sink.commit(1);
      }),
    );
    expect(new Set(results.map(({ name }) => name))).toEqual(
      new Set(["same.txt", "same (1).txt", "same (2).txt"]),
    );
    expect(new Set(results.map(({ localPathOrHandle }) => localPathOrHandle)).size).toBe(3);
    for (const [index, result] of results.entries()) {
      expect(new Uint8Array(await urls.blobs.get(result.localPathOrHandle).arrayBuffer())).toEqual(
        Uint8Array.of(index),
      );
    }
    await disposeReceivedFiles();
    expect(urls.blobs.size).toBe(0);
    expect(urls.revoke).toHaveBeenCalledTimes(3);
  });

  it("removes a failed OPFS preparation before accepting any bytes into memory", async () => {
    const urls = blobStore();
    const disk = opfsStorage({ fail: "prepare" });
    const sink = await prepareReceivedFile("received.bin", disk.storage, disk.locks);
    expect(disk.removed).toHaveLength(1);
    expect(disk.removed[0]).toMatch(/^\.ponlet-.+\.part$/);
    expect(Array.from(disk.entries.keys())).toEqual(["existing.bin"]);
    expect(disk.openHandles.size).toBe(0);
    await sink.write(Uint8Array.of(1, 2));
    expect((await sink.commit(2)).localPathOrHandle).toMatch(/^blob:/);
    expect(urls.create).toHaveBeenCalledTimes(1);
  });

  it("keeps OPFS receives on disk and uses the portable directory+name move form", async () => {
    const urls = blobStore();
    const disk = opfsStorage();
    const sink = await prepareReceivedFile("existing.bin", disk.storage, disk.locks);
    await sink.write(Uint8Array.of(1, 2, 3));
    expect(await sink.commit(3)).toEqual({
      name: "existing (1).bin",
      size: 3,
      localPathOrHandle: "opfs:/Ponlet/existing (1).bin",
    });
    expect(disk.entries.get("existing.bin")).toEqual(Uint8Array.of(9));
    expect(disk.entries.get("existing (1).bin")).toEqual(Uint8Array.of(1, 2, 3));
    expect(disk.openHandles.size).toBe(0);
    expect(urls.create).not.toHaveBeenCalled();
  });

  it.each(["write", "close", "move"])(
    "does not switch to memory after an OPFS %s failure",
    async (fail) => {
      const urls = blobStore();
      const disk = opfsStorage({ fail });
      const sink = await prepareReceivedFile("received.bin", disk.storage, disk.locks);
      if (fail === "write") {
        await expect(sink.write(Uint8Array.of(1))).rejects.toThrow("write failed");
      } else {
        await sink.write(Uint8Array.of(1));
        await expect(sink.commit(1)).rejects.toThrow(`${fail} failed`);
      }
      expect(Array.from(disk.entries.keys())).toEqual(["existing.bin"]);
      expect(disk.openHandles.size).toBe(0);
      expect(urls.create).not.toHaveBeenCalled();
      await expect(sink.commit(1)).rejects.toThrow("closed");
    },
  );

  it("keeps the fail-closed no-clobber rule when OPFS works but Web Locks do not", async () => {
    const urls = blobStore();
    const disk = opfsStorage();
    const sink = await prepareReceivedFile("existing.bin", disk.storage, null);
    await sink.write(Uint8Array.of(1));
    await expect(sink.commit(1)).rejects.toThrow("Web Locks");
    expect(Array.from(disk.entries.keys())).toEqual(["existing.bin"]);
    expect(disk.entries.get("existing.bin")).toEqual(Uint8Array.of(9));
    expect(urls.create).not.toHaveBeenCalled();
  });
});

describe("worker receive cancellation", () => {
  it("discards a partial memory receive on abort and never publishes a URL", async () => {
    const urls = blobStore();
    const sink = await prepareReceivedFile("partial.bin", unavailableStorage, null);
    await sink.write(Uint8Array.of(1, 2));
    await sink.abort();
    await expect(sink.write(Uint8Array.of(3))).rejects.toThrow("closed");
    await expect(sink.commit(2)).rejects.toThrow("closed");
    expect(urls.create).not.toHaveBeenCalled();
  });

  it("discards a mismatched memory receive and permits an empty file", async () => {
    const urls = blobStore();
    const sink = await prepareReceivedFile("partial.bin", unavailableStorage, null);
    await sink.write(Uint8Array.of(1, 2));
    await expect(sink.commit(3)).rejects.toThrow("size mismatch");
    expect(urls.create).not.toHaveBeenCalled();
    const empty = await prepareReceivedFile("empty.bin", unavailableStorage, null);
    const item = await empty.commit(0);
    expect(item.size).toBe(0);
    expect(urls.blobs.get(item.localPathOrHandle).size).toBe(0);
  });

  it("revokes a Blob URL when cancellation arrives before commit can publish it", async () => {
    const urls = blobStore();
    const sink = await prepareReceivedFile("cancelled.bin", unavailableStorage, null);
    const url = `blob:${location.origin}/cancelled-commit`;
    urls.create.mockImplementation((blob) => {
      urls.blobs.set(url, blob);
      queueMicrotask(() => {
        void sink.abort();
      });
      return url;
    });
    await sink.write(Uint8Array.of(1));
    await expect(sink.commit(1)).rejects.toThrow("closed");
    expect(urls.blobs.size).toBe(0);
    expect(urls.revoke).toHaveBeenCalledWith(url);
  });

  it("aborts incomplete memory receives during backend disposal", async () => {
    const urls = blobStore();
    const sink = await prepareReceivedFile("partial.bin", unavailableStorage, null);
    await sink.write(Uint8Array.of(1, 2));
    await disposeReceivedFiles();
    await expect(sink.commit(2)).rejects.toThrow("closed");
    expect(urls.create).not.toHaveBeenCalled();
  });

  it("cleans an OPFS writer that finishes preparing after disposal without selecting memory", async () => {
    const urls = blobStore();
    const entered = deferred();
    const gate = deferred();
    const disk = opfsStorage({
      preparing: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const prepared = prepareReceivedFile("partial.bin", disk.storage, disk.locks);
    await entered.promise;
    let disposed = false;
    const disposal = disposeReceivedFiles().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    gate.resolve();
    await expect(prepared).rejects.toThrow("disposed");
    await disposal;
    expect(Array.from(disk.entries.keys())).toEqual(["existing.bin"]);
    expect(disk.openHandles.size).toBe(0);
    expect(urls.create).not.toHaveBeenCalled();
  });

  it("waits for cleanup from an abort that already started before disposal", async () => {
    const urls = blobStore();
    const entered = deferred();
    const gate = deferred();
    const disk = opfsStorage({
      aborting: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const sink = await prepareReceivedFile("partial.bin", disk.storage, disk.locks);
    await sink.write(Uint8Array.of(1));
    const abort = sink.abort();
    await entered.promise;
    let disposed = false;
    const disposal = disposeReceivedFiles().then(() => {
      disposed = true;
    });
    try {
      // Let an incorrectly empty disposal queue resolve before checking it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(false);
      expect(disk.openHandles.size).toBe(1);
      expect(disk.entries.size).toBe(2);
    } finally {
      gate.resolve();
      await abort;
      await disposal;
    }
    expect(Array.from(disk.entries.keys())).toEqual(["existing.bin"]);
    expect(disk.openHandles.size).toBe(0);
    expect(urls.create).not.toHaveBeenCalled();
  });

  it("waits for write-failure cleanup that already started before disposal", async () => {
    const urls = blobStore();
    const entered = deferred();
    const gate = deferred();
    const disk = opfsStorage({
      fail: "write",
      aborting: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const sink = await prepareReceivedFile("partial.bin", disk.storage, disk.locks);
    const rejected = expect(sink.write(Uint8Array.of(1))).rejects.toThrow("write failed");
    await entered.promise;
    let disposed = false;
    const disposal = disposeReceivedFiles().then(() => {
      disposed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toBe(false);
      expect(disk.openHandles.size).toBe(1);
      expect(disk.entries.size).toBe(2);
    } finally {
      gate.resolve();
      await rejected;
      await disposal;
    }
    expect(Array.from(disk.entries.keys())).toEqual(["existing.bin"]);
    expect(disk.openHandles.size).toBe(0);
    expect(urls.create).not.toHaveBeenCalled();
  });

  it("finishes cleanup of an in-flight write before disposal resolves", async () => {
    const urls = blobStore();
    const entered = deferred();
    const gate = deferred();
    const disk = opfsStorage({
      writing: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const sink = await prepareReceivedFile("partial.bin", disk.storage, disk.locks);
    const write = sink.write(Uint8Array.of(1));
    const rejected = expect(write).rejects.toThrow("closed");
    await entered.promise;
    const disposal = disposeReceivedFiles();
    gate.resolve();
    await rejected;
    await disposal;
    expect(Array.from(disk.entries.keys())).toEqual(["existing.bin"]);
    expect(disk.openHandles.size).toBe(0);
    expect(urls.create).not.toHaveBeenCalled();
  });
});
