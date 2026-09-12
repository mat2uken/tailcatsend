import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadOpfsItem } from "../src/opfs.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("received file downloads", () => {
  it("downloads worker Blob URLs repeatedly without copying or revoking their contents", async () => {
    const clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      clicks.push({ href: this.href, download: this.download });
    });
    const create = vi.spyOn(URL, "createObjectURL");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const fetch = vi.spyOn(globalThis, "fetch");
    const url = `blob:${location.origin}/worker-receive`;
    await downloadOpfsItem(url, "受信.bin");
    await downloadOpfsItem(url, "受信.bin");
    expect(clicks).toEqual([
      { href: url, download: "受信.bin" },
      { href: url, download: "受信.bin" },
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector("a")).toBeNull();
  });

  it("rejects an unrelated Blob origin and unsupported URL schemes", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await expect(downloadOpfsItem("blob:https://unrelated.example/file", "file")).rejects.toThrow(
      "another origin",
    );
    await expect(downloadOpfsItem("https://unrelated.example/file", "file")).rejects.toThrow(
      "not available in OPFS",
    );
    await expect(downloadOpfsItem("javascript:alert(1)", "file")).rejects.toThrow(
      "not available in OPFS",
    );
    expect(click).not.toHaveBeenCalled();
  });

  it("still opens completed OPFS files and revokes only the URL created for that download", async () => {
    vi.useFakeTimers();
    const file = new File([Uint8Array.of(1, 2)], "received.bin");
    vi.stubGlobal("navigator", {
      storage: {
        async getDirectory() {
          return {
            async getDirectoryHandle() {
              return {
                async getFileHandle() {
                  return {
                    async getFile() {
                      return file;
                    },
                  };
                },
              };
            },
          };
        },
      },
    });
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue(`blob:${location.origin}/opfs-download`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      clicks.push({ href: this.href, download: this.download });
    });
    await downloadOpfsItem("opfs:/Ponlet/received.bin", "");
    expect(create).toHaveBeenCalledWith(file);
    expect(clicks).toEqual([
      { href: `blob:${location.origin}/opfs-download`, download: "received.bin" },
    ]);
    expect(revoke).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(revoke).toHaveBeenCalledWith(`blob:${location.origin}/opfs-download`);
  });
});
