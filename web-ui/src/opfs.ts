/** Download completed files prepared by worker-storage without reading bytes into the UI. */
interface OpfsFileHandle {
  getFile?: () => Promise<File>;
}

interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string): Promise<OpfsFileHandle>;
}

interface StorageWithOpfs {
  getDirectory?: () => Promise<OpfsDirectoryHandle>;
}

function getStorage(): StorageWithOpfs {
  return (globalThis.navigator as Navigator & { storage?: StorageWithOpfs }).storage ?? {};
}

async function opfsFile(handleName: string): Promise<File> {
  if (!handleName.startsWith("opfs:/")) {
    throw new Error("Received file is not available in OPFS");
  }
  const parts = handleName
    .slice("opfs:/".length)
    .split("/")
    .filter((part) => part.length > 0);
  if (
    parts.length !== 2 ||
    parts[0] === "." ||
    parts[0] === ".." ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    throw new Error("Invalid OPFS file handle");
  }
  const storage = getStorage();
  if (!storage.getDirectory) {
    throw new Error("OPFS is unavailable");
  }
  const root = await storage.getDirectory();
  const directory = await root.getDirectoryHandle(parts[0]);
  const handle = await directory.getFileHandle(parts[1]);
  if (!handle.getFile) {
    throw new Error("OPFS file reading is unavailable");
  }
  return handle.getFile();
}

/** Download a completed browser receive without copying it through the UI. */
export async function downloadOpfsItem(handleName: string, name: string): Promise<void> {
  let url: string;
  let downloadName = name;
  let revokeAfterDownload = false;
  if (handleName.startsWith("blob:")) {
    // A completed compatibility receive is already a Blob URL in the worker.
    // Passing its URL avoids reading the complete file back into the UI.
    const parsed = new URL(handleName);
    if (parsed.origin !== globalThis.location.origin) {
      throw new Error("Received Blob URL belongs to another origin");
    }
    url = parsed.href;
  } else {
    const file = await opfsFile(handleName);
    url = URL.createObjectURL(file);
    downloadName ||= file.name;
    revokeAfterDownload = true;
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadName || "received.bin";
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Worker-owned URLs survive repeated downloads and normal disconnects.
    // Backend disposal explicitly revokes them after aborting partial receives.
    if (revokeAfterDownload) {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
}
