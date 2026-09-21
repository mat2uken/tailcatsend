import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

export function serveStatic({ dist, uiDist }) {
  const server = createServer((request, response) => {
    try {
      const requestPath = decodeURIComponent((request.url ?? "/").split("?", 1)[0]);
      const relative = requestPath === "/" ? "/index.html" : requestPath;
      const uiFile = resolve(uiDist, `.${relative}`);
      const distFile = resolve(dist, `.${relative}`);
      const file = existsSync(uiFile) ? uiFile : distFile;
      if (!(file.startsWith(`${dist}${sep}`) || file.startsWith(`${uiDist}${sep}`))) {
        response.writeHead(400).end("invalid path");
        return;
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        response.writeHead(404).end("not found");
        return;
      }
      const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      });
      // The artifact can disappear after the checks above during a rebuild.
      // End only this response instead of crashing every peer's test server.
      createReadStream(file).on("error", () => response.destroy()).pipe(response);
    } catch (error) {
      response.writeHead(400).end(String(error));
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveServer({ server, port: server.address().port });
    });
  });
}
