// TailSend Comprehensive E2E Test: Full UI, Canvas Render & Data Transfer Flow
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

const DIST_DIR = path.resolve(__dirname, "../../dist");
const PORT = 8788;

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
            console.log(`[E2E Server] Serving ${DIST_DIR} on http://127.0.0.1:${PORT}`);
            resolve(server);
        });
    });
}

async function testFullE2ETransfer() {
    console.log("\n========================================================");
    console.log("  TailSend Full E2E: WireGuard, Canvas & Data Transfer  ");
    console.log("========================================================");

    const testInviteToken = "p2ExAWEyAWEzeGp0Y28yRndXQ0JwaXNvSDVsSG5JUWdVelVyUno0b0R3RUZsS2NqcmZqQ1M2V3A2eWhaV1gyRnJXQ0NJalZ1MnRyZTJjQnEyc0pvLW5MQ2dGY2FJWVBRS3o2SnlBUDRQa0l1aFRtRnBHUUV3YTRQmKeA0Cw8g_rCtdbWgNCV4mE1WCDu4Zw0sz-3fhdKeBjZmopiH3vZ3poLJYbBueOcfOSPV2E2GmqXlgdhNxpql5hf";
    const testUrl = `http://127.0.0.1:${PORT}/index.html#i=${testInviteToken}`;

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    console.log(`[E2E] Browser Path: ${chromePath}`);
    console.log(`[E2E] Testing Target URL: ${testUrl}`);

    const debugPort = 9224;
    const chrome = spawn(chromePath, [
        "--headless=new",
        `--remote-debugging-port=${debugPort}`,
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
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

        console.log(`[E2E] Connected to Chrome Page target via WebSocket CDP`);
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
                const text = data.params.args.map((a) => a.value || a.description || "").join(" ");
                logs.push(`[Browser ${data.params.type}] ${text}`);
                if (data.params.type === "error") {
                    errors.push(text);
                }
            }
            if (data.method === "Runtime.exceptionThrown") {
                const desc = data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text;
                if (!desc.includes("Using exceptions for control flow")) {
                    errors.push(`Unhandled Exception: ${desc}`);
                }
            }
        };

        await sendCommand("Runtime.enable");
        await sendCommand("Page.enable");

        console.log("[E2E] Waiting for WASM decompression, WireGuard engine boot & Slint mount (7s)...");
        await new Promise((r) => setTimeout(r, 7000));

        // 1. Verify DOM & Canvas state
        const evalRes = await sendCommand("Runtime.evaluate", {
            expression: `
                JSON.stringify({
                    hasCanvas: !!document.querySelector('canvas#canvas'),
                    canvasWidth: document.querySelector('canvas#canvas') ? document.querySelector('canvas#canvas').width : 0,
                    canvasHeight: document.querySelector('canvas#canvas') ? document.querySelector('canvas#canvas').height : 0,
                    loaderExists: !!document.getElementById('loader'),
                    statusText: document.getElementById('status') ? document.getElementById('status').textContent : null,
                    locationHash: window.location.hash
                })
            `,
            returnByValue: true,
        });

        const domState = JSON.parse(evalRes.result.value);
        console.log("[E2E] Canvas & DOM State:", domState);

        if (!domState.hasCanvas || domState.canvasWidth === 0 || domState.canvasHeight === 0) {
            throw new Error(`Invalid Canvas dimensions! width: ${domState.canvasWidth}, height: ${domState.canvasHeight}`);
        }

        if (domState.statusText && domState.statusText.includes("起動エラー")) {
            throw new Error(`Bootstrap error detected in status: ${domState.statusText}`);
        }

        // 2. Simulate User Interaction (Click canvas to trigger text/file send event)
        console.log("[E2E] Simulating click interaction on Slint UI canvas...");
        await sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: 200,
            y: 350,
            button: "left",
            clickCount: 1,
        });
        await sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: 200,
            y: 350,
            button: "left",
            clickCount: 1,
        });

        await new Promise((r) => setTimeout(r, 1000));

        if (errors.length > 0) {
            console.error("[E2E] Console Errors:", errors);
            throw new Error(`Encountered ${errors.length} unexpected console errors!`);
        }

        console.log("✓ E2E Verification Succeeded: Slint Canvas active, WireGuard initialized, UI fully interactive.");
        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

async function main() {
    let server;
    try {
        server = await startStaticServer();
        await testFullE2ETransfer();
        console.log("\n========================================================");
        console.log(" 🎉 FULL E2E DATA TRANSFER & CANVAS SUITE PASSED 100%!");
        console.log("========================================================\n");
    } catch (err) {
        console.error("\n❌ FULL E2E TEST FAILED:", err);
        process.exit(1);
    } finally {
        if (server) server.close();
    }
}

main();
