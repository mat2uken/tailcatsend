// TailSend Local Static Web Server for Mobile & LAN testing
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIST_DIR = path.resolve(__dirname, "../dist");
const PORT = 8787;
const HOST = "0.0.0.0";

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".gz": "application/gzip",
    ".json": "application/json",
    ".css": "text/css",
    ".png": "image/png",
    ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0].split("#")[0];
    if (reqPath === "/") reqPath = "/index.html";

    const filePath = path.join(DIST_DIR, reqPath);
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`404 Not Found: ${reqPath}`);
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    let contentType = MIME_TYPES[ext] || "application/octet-stream";
    if (filePath.endsWith(".wasm.gz")) {
        contentType = "application/gzip";
    }

    res.writeHead(200, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
    });

    fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
    console.log(`[TailSend Server] Running at http://${HOST}:${PORT}`);
    console.log(`[TailSend Server] Serving directory: ${DIST_DIR}`);
});
