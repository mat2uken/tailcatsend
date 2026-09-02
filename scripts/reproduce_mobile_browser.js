// Mobile Browser Emulation & Full Diagnostic Capture
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DIST_DIR = path.resolve(__dirname, "../dist");
const PORT = 8789;

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

function startStaticServer() {
    return new Promise((resolve) => {
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

        server.listen(PORT, "127.0.0.1", () => {
            console.log(`[Diagnostic Server] Serving ${DIST_DIR} on http://127.0.0.1:${PORT}`);
            resolve(server);
        });
    });
}

async function runDiagnostic() {
    const testToken = "p2ExAWEyAWEzcnRjLWhvc3QtcGMtd2luZG93c2E0UAEBAQEBAQEBAQEBAQEBAQFhNVggAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJhNhpql5rUYTcaapeo5A";
    const testUrl = `http://127.0.0.1:${PORT}/index.html#i=${testToken}`;

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9225;
    const chrome = spawn(chromePath, [
        "--headless=new",
        `--remote-debugging-port=${debugPort}`,
        "--disable-gpu",
        "--no-sandbox",
        "--window-size=390,844",
        "--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        testUrl,
    ]);

    const logs = [];
    const errors = [];

    try {
        await new Promise((r) => setTimeout(r, 2000));

        const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await targetsRes.json();
        const pageTarget = targets.find((t) => t.type === "page");

        if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
            throw new Error("No Chrome page target with WebSocket debugger found");
        }

        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

        let msgId = 1;
        const pending = new Map();

        function sendCommand(method, params = {}) {
            return new Promise((resolve) => {
                const id = msgId++;
                pending.set(id, resolve);
                ws.send(JSON.stringify({ id, method, params }));
            });
        }

        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.id && pending.has(data.id)) {
                const resolve = pending.get(data.id);
                pending.delete(data.id);
                resolve(data.result);
            }
            if (data.method === "Runtime.consoleAPICalled") {
                const text = data.params.args.map((a) => a.value || a.description || JSON.stringify(a)).join(" ");
                console.log(`[Browser Console ${data.params.type}]`, text);
                logs.push(`[${data.params.type}] ${text}`);
                if (data.params.type === "error") {
                    errors.push(text);
                }
            }
            if (data.method === "Runtime.exceptionThrown") {
                const desc = data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text;
                console.error("[Browser Exception]", desc);
                errors.push(`Exception: ${desc}`);
            }
        };

        await sendCommand("Runtime.enable");
        await sendCommand("Page.enable");
        await sendCommand("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            mobile: true,
        });

        console.log("[Diagnostic] Waiting 8s for WASM loading and rendering...");
        await new Promise((r) => setTimeout(r, 8000));

        // Capture Screenshot
        const screenshotRes = await sendCommand("Page.captureScreenshot", { format: "png" });
        if (screenshotRes && screenshotRes.data) {
            fs.writeFileSync("mobile_screenshot.png", Buffer.from(screenshotRes.data, "base64"));
            console.log("[Diagnostic] Captured mobile screenshot to mobile_screenshot.png");
        }

        // Evaluate detailed Canvas and WebGL state
        const diagEval = await sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    const canvases = Array.from(document.querySelectorAll('canvas')).map(c => ({
                        id: c.id,
                        width: c.width,
                        height: c.height,
                        clientWidth: c.clientWidth,
                        clientHeight: c.clientHeight,
                        style: c.getAttribute('style'),
                        parentTag: c.parentElement ? c.parentElement.tagName : null
                    }));

                    const canvas = document.getElementById('canvas') || document.querySelector('canvas');
                    let pixelSample = null;
                    let contextType = 'none';
                    if (canvas) {
                        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
                        if (gl) {
                            contextType = gl.constructor.name;
                            const pixels = new Uint8Array(4);
                            gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                            pixelSample = Array.from(pixels);
                        } else {
                            const ctx2d = canvas.getContext('2d');
                            if (ctx2d) {
                                contextType = 'CanvasRenderingContext2D';
                                const imgData = ctx2d.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1);
                                pixelSample = Array.from(imgData.data);
                            }
                        }
                    }

                    return {
                        canvasCount: canvases.length,
                        canvases: canvases,
                        contextType: contextType,
                        pixelSample: pixelSample,
                        bodyHTML: document.body.innerHTML
                    };
                })()
            `,
            returnByValue: true,
        });

        console.log("\n=== Detailed Diagnostic Result ===");
        console.log(JSON.stringify(diagEval.result.value, null, 2));

        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

async function main() {
    let server;
    try {
        server = await startStaticServer();
        await runDiagnostic();
    } catch (err) {
        console.error("Diagnostic execution error:", err);
    } finally {
        if (server) server.close();
    }
}

main();
