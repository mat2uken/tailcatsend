import { describe, expect, it } from "vitest";
import { commitReceivedFile, createReceivedWriter } from "../src/worker-storage.ts";

function sharedStorage(initial = []) {
  const entries = new Map(initial);
  const queues = new Map();
  const locks = () => ({
    request(name, callback) {
      const pending = (queues.get(name) ?? Promise.resolve()).then(callback);
      queues.set(
        name,
        pending.catch(() => {}),
      );
      return pending;
    },
  });
  const directory = () => ({
    async getFileHandle(name) {
      if (!entries.has(name)) {
        throw new DOMException("Missing", "NotFoundError");
      }
      if (entries.get(name) === null) {
        throw new DOMException("Directory", "TypeMismatchError");
      }
      return entries.get(name);
    },
  });
  const receive = (temporary, contents, beforeMove = async () => {}) => {
    entries.set(temporary, contents);
    return {
      name: temporary,
      async move(directory, name) {
        expect(directory.getFileHandle).toBeTypeOf("function");
        expect(name).toBeTypeOf("string");
        await beforeMove();
        // OPFS move replaces a target file. The helper must prevent that.
        entries.set(name, entries.get(temporary));
        entries.delete(temporary);
      },
    };
  };
  return { directory, entries, locks, receive };
}

describe("OPFS receive commit", () => {
  it("preserves existing files during simultaneous commits from separate workers", async () => {
    const storage = sharedStorage([
      ["photo.png", "previous receive"],
      ["photo (1).png", "another previous receive"],
    ]);
    const commits = Array.from({ length: 16 }, (_, index) => {
      const contents = `receive ${index}`;
      const file = storage.receive(`.temporary-${index}.part`, contents);
      return commitReceivedFile(storage.directory(), file, "photo.png", storage.locks()).then(
        (name) => ({ contents, name }),
      );
    });
    const results = await Promise.all(commits);
    expect(new Set(results.map(({ name }) => name)).size).toBe(16);
    for (const { contents, name } of results) {
      expect(storage.entries.get(name)).toBe(contents);
    }
    expect(storage.entries.get("photo.png")).toBe("previous receive");
    expect(storage.entries.get("photo (1).png")).toBe("another previous receive");
    expect(storage.entries.size).toBe(18);
  });

  it("holds the origin lock until the move finishes", async () => {
    const storage = sharedStorage();
    let releaseMove;
    const moveGate = new Promise((resolve) => {
      releaseMove = resolve;
    });
    let notifyMoving;
    const moving = new Promise((resolve) => {
      notifyMoving = resolve;
    });
    const firstFile = storage.receive(".first.part", "first", async () => {
      notifyMoving();
      await moveGate;
    });
    const first = commitReceivedFile(storage.directory(), firstFile, "same.txt", storage.locks());
    await moving;
    const secondFile = storage.receive(".second.part", "second");
    const second = commitReceivedFile(storage.directory(), secondFile, "same.txt", storage.locks());
    releaseMove();
    expect(await first).toBe("same.txt");
    expect(await second).toBe("same (1).txt");
    expect(storage.entries.get("same.txt")).toBe("first");
    expect(storage.entries.get("same (1).txt")).toBe("second");
  });

  it("preserves directory entries and numbers dotfiles without adding an extension", async () => {
    const storage = sharedStorage([
      [".config", null],
      [".config (1)", "existing"],
    ]);
    const file = storage.receive(".temporary.part", "new receive");
    const name = await commitReceivedFile(storage.directory(), file, ".config", storage.locks());
    expect(name).toBe(".config (2)");
    expect(storage.entries.get(".config")).toBeNull();
    expect(storage.entries.get(".config (1)")).toBe("existing");
    expect(storage.entries.get(name)).toBe("new receive");
  });

  it("does not move or overwrite files when Web Locks are unavailable", async () => {
    const storage = sharedStorage([["received.txt", "existing"]]);
    const file = storage.receive(".temporary.part", "new receive");
    await expect(
      commitReceivedFile(storage.directory(), file, "received.txt", null),
    ).rejects.toThrow("Web Locks");
    expect(storage.entries.get("received.txt")).toBe("existing");
    expect(storage.entries.get(".temporary.part")).toBe("new receive");
  });

  it("propagates lookup failures and releases the lock for the next receive", async () => {
    const storage = sharedStorage([["received.txt", "existing"]]);
    const failed = storage.receive(".failed.part", "failed receive");
    const denied = {
      async getFileHandle() {
        throw new DOMException("Denied", "NotAllowedError");
      },
    };
    await expect(
      commitReceivedFile(denied, failed, "received.txt", storage.locks()),
    ).rejects.toThrow("Denied");
    expect(storage.entries.get("received.txt")).toBe("existing");
    expect(storage.entries.get(".failed.part")).toBe("failed receive");
    const file = storage.receive(".next.part", "next receive");
    expect(
      await commitReceivedFile(storage.directory(), file, "received.txt", storage.locks()),
    ).toBe("received (1).txt");
    expect(storage.entries.get("received (1).txt")).toBe("next receive");
  });
});

function compatibilityStorage({
  asynchronous = false,
  maxWrite = 7000,
  failWrite,
  failFlush,
} = {}) {
  const entries = new Map();
  const openHandles = new Set();
  const reads = [];
  const writes = [];
  const locks = sharedStorage().locks();
  const handle = (name) => {
    const write = (chunk, offset) => {
      if (name === failWrite) {
        throw new DOMException("Disk full", "QuotaExceededError");
      }
      const count = Math.min(chunk.byteLength, maxWrite);
      const old = entries.get(name);
      const bytes = new Uint8Array(Math.max(old.byteLength, offset + count));
      bytes.set(old);
      bytes.set(chunk.subarray(0, count), offset);
      entries.set(name, bytes);
      writes.push(count);
      return count;
    };
    const file = {
      name,
      async getFile() {
        const bytes = entries.get(name);
        return {
          size: bytes.byteLength,
          async arrayBuffer() {
            throw new Error("Whole-file buffering is forbidden");
          },
          slice(start, end) {
            return {
              async arrayBuffer() {
                const result = bytes.slice(start, end);
                reads.push(result.byteLength);
                return result.buffer;
              },
            };
          },
        };
      },
    };
    if (asynchronous) {
      file.createWritable = async () => {
        let offset = 0;
        entries.set(name, new Uint8Array());
        openHandles.add(name);
        return {
          async write(chunk) {
            // The asynchronous API writes the complete chunk before resolving.
            let written = 0;
            while (written < chunk.byteLength) {
              const count = write(chunk.subarray(written), offset);
              written += count;
              offset += count;
            }
          },
          async close() {
            openHandles.delete(name);
          },
          async abort() {
            openHandles.delete(name);
          },
        };
      };
    } else {
      file.createSyncAccessHandle = async () => {
        if (openHandles.has(name)) {
          throw new Error("File handle still locked");
        }
        openHandles.add(name);
        return {
          truncate(size) {
            entries.set(name, entries.get(name).slice(0, size));
          },
          write(chunk, { at }) {
            return write(chunk, at);
          },
          flush() {
            if (name === failFlush) {
              throw new DOMException("Flush failed", "QuotaExceededError");
            }
          },
          close() {
            openHandles.delete(name);
          },
        };
      };
    }
    return file;
  };
  const directory = {
    async getFileHandle(name, options) {
      if (!entries.has(name)) {
        if (!options?.create) {
          throw new DOMException("Missing", "NotFoundError");
        }
        entries.set(name, new Uint8Array());
      }
      return handle(name);
    },
    async removeEntry(name) {
      entries.delete(name);
    },
  };
  return { directory, entries, handle, locks, openHandles, reads, writes };
}

describe("OPFS browser compatibility", () => {
  it("receives and commits through sync handles with partial writes and no move API", async () => {
    const storage = compatibilityStorage();
    const previous = Uint8Array.of(9, 8, 7);
    storage.entries.set("received.bin", previous);
    const contents = Uint8Array.from({ length: 160_003 }, (_, index) => index % 251);
    const file = await storage.directory.getFileHandle(".temporary.part", { create: true });
    const writer = await createReceivedWriter(file);
    await writer.write(contents.subarray(0, 60_000));
    await writer.write(contents.subarray(60_000, 120_000));
    await writer.write(contents.subarray(120_000));
    await writer.close();
    const name = await commitReceivedFile(storage.directory, file, "received.bin", storage.locks);
    expect(name).toBe("received (1).bin");
    expect(storage.entries.get(name)).toEqual(contents);
    expect(storage.entries.get("received.bin")).toEqual(previous);
    expect(storage.entries.has(".temporary.part")).toBe(false);
    expect(storage.openHandles.size).toBe(0);
    expect(Math.max(...storage.reads)).toBeLessThanOrEqual(64 * 1024);
    expect(storage.reads).toHaveLength(3);
    expect(storage.writes.length).toBeGreaterThan(6);
    await expect(writer.write(Uint8Array.of(1))).rejects.toThrow("closed");
  });

  it("copies simultaneous same-name receives through async writers when move is unavailable", async () => {
    const storage = compatibilityStorage({ asynchronous: true });
    const previous = Uint8Array.of(1, 2);
    storage.entries.set("received.bin", previous);
    const commits = Array.from({ length: 4 }, (_, index) => {
      const temporary = `.temporary-${index}.part`;
      const contents = new Uint8Array(130_001).fill(index + 10);
      storage.entries.set(temporary, contents);
      return commitReceivedFile(
        storage.directory,
        storage.handle(temporary),
        "received.bin",
        storage.locks,
      ).then((name) => ({ name, contents }));
    });
    const results = await Promise.all(commits);
    expect(new Set(results.map(({ name }) => name)).size).toBe(4);
    for (const { name, contents } of results) {
      expect(storage.entries.get(name)).toEqual(contents);
    }
    expect(storage.entries.get("received.bin")).toEqual(previous);
    expect(storage.entries.size).toBe(5);
    expect(storage.openHandles.size).toBe(0);
    expect(Math.max(...storage.reads)).toBeLessThanOrEqual(64 * 1024);
  });

  it("falls back when an exposed move method reports that it is unsupported", async () => {
    const storage = compatibilityStorage();
    storage.entries.set(".temporary.part", Uint8Array.of(1, 2, 3));
    const file = storage.handle(".temporary.part");
    file.move = async () => {
      throw new DOMException("Unavailable", "NotSupportedError");
    };
    expect(await commitReceivedFile(storage.directory, file, "new.bin", storage.locks)).toBe(
      "new.bin",
    );
    expect(storage.entries.get("new.bin")).toEqual(Uint8Array.of(1, 2, 3));
  });

  it.each(["write", "flush"])(
    "cleans up a failed copy after a %s error and preserves previous receives",
    async (failure) => {
      const storage = compatibilityStorage({
        failWrite: failure === "write" ? "received (1).bin" : undefined,
        failFlush: failure === "flush" ? "received (1).bin" : undefined,
      });
      storage.entries.set("received.bin", Uint8Array.of(9));
      storage.entries.set(".temporary.part", Uint8Array.of(1, 2, 3));
      await expect(
        commitReceivedFile(
          storage.directory,
          storage.handle(".temporary.part"),
          "received.bin",
          storage.locks,
        ),
      ).rejects.toThrow(failure === "write" ? "Disk full" : "Flush failed");
      expect(storage.entries.get("received.bin")).toEqual(Uint8Array.of(9));
      expect(storage.entries.get(".temporary.part")).toEqual(Uint8Array.of(1, 2, 3));
      expect(storage.entries.has("received (1).bin")).toBe(false);
      expect(storage.openHandles.size).toBe(0);
    },
  );

  it("rejects a zero-length partial write and can release the sync handle on abort", async () => {
    const storage = compatibilityStorage({ maxWrite: 0 });
    const file = await storage.directory.getFileHandle(".temporary.part", { create: true });
    const writer = await createReceivedWriter(file);
    await expect(writer.write(Uint8Array.of(1))).rejects.toThrow("complete file chunk");
    await writer.abort();
    expect(storage.openHandles.size).toBe(0);
  });
});
