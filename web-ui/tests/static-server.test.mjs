// @vitest-environment node
import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "../../tests/e2e/static-server.mjs";

it("serves UI overrides and runtime artifacts while rejecting invalid paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponlet-static-"));
  const dist = join(root, "dist");
  const uiDist = join(root, "ui");
  let server;
  try {
    await mkdir(dist);
    await mkdir(uiDist);
    await mkdir(join(uiDist, "assets"));
    await writeFile(join(dist, "index.html"), "old entry");
    await writeFile(join(uiDist, "index.html"), "current UI");
    await writeFile(join(dist, "runtime.wasm"), Buffer.from([0, 97, 115, 109]));
    await writeFile(join(root, "private.txt"), "outside roots");
    const started = await serveStatic({ dist, uiDist });
    server = started.server;
    const url = `http://127.0.0.1:${started.port}`;
    const entry = await fetch(`${url}/?mode=test`);
    expect(await entry.text()).toBe("current UI");
    expect(entry.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(entry.headers.get("cache-control")).toBe("no-store");
    const runtime = await fetch(`${url}/runtime.wasm`);
    expect(runtime.headers.get("content-type")).toBe("application/wasm");
    expect(new Uint8Array(await runtime.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect((await fetch(`${url}/missing`)).status).toBe(404);
    expect((await fetch(`${url}/assets/`)).status).toBe(404);
    expect(await (await fetch(`${url}/`)).text()).toBe("current UI");
    expect((await fetch(`${url}/%2e%2e%2fprivate.txt`)).status).toBe(400);
    expect((await fetch(`${url}/%zz`)).status).toBe(400);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(root, { recursive: true, force: true });
  }
});
