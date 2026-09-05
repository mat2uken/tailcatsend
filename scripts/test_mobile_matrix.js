// Comprehensive Mobile & Responsive Verification Matrix
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DIST_DIR = path.resolve(__dirname, "../dist");
const PORT = 8790;

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
            console.log(`[Test Server] Serving ${DIST_DIR} on http://127.0.0.1:${PORT}`);
            resolve(server);
        });
    });
}

async function runTestMatrix() {
    const testUrl = `http://127.0.0.1:${PORT}/index.html`;

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9226;
    const chrome = spawn(chromePath, [
        "--headless=new",
        `--remote-debugging-port=${debugPort}`,
        "--disable-gpu",
        "--no-sandbox",
        "--window-size=390,844",
        "--force-device-scale-factor=3",
        "--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        testUrl,
    ]);

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
        };

        await sendCommand("Runtime.enable");
        await sendCommand("Page.enable");

        // 1. Portrait Mode (390 x 844)
        console.log("[Test 1/4] Setting Portrait Mode (390x844)...");
        await sendCommand("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            mobile: true,
        });
        await sendCommand("Runtime.evaluate", { expression: "window.dispatchEvent(new Event('resize'));" });
        await new Promise((r) => setTimeout(r, 8000)); // Wait for initial wasm render

        let shot = await sendCommand("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync("mobile_portrait.png", Buffer.from(shot.data, "base64"));
        console.log(" -> Saved mobile_portrait.png");

        // 2. Tab Switch: Click '相手に接続' (Join Peer) Tab
        // In 390x844 with 14px padding, tabs are at y~85-110, right tab x ~ 290
        console.log("[Test 2/4] Switching to 'Join Peer' tab...");
        await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 290, y: 92, button: "left", clickCount: 1 });
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 290, y: 92, button: "left", clickCount: 1 });
        await new Promise((r) => setTimeout(r, 1000));

        shot = await sendCommand("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync("mobile_join_tab.png", Buffer.from(shot.data, "base64"));
        console.log(" -> Saved mobile_join_tab.png");

        // 3. Language Switch: Click 'EN' Button
        // Header is at top: EN pill is at x ~ 355, y ~ 29
        console.log("[Test 3/4] Switching Language to English (EN)...");
        await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 355, y: 29, button: "left", clickCount: 1 });
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 355, y: 29, button: "left", clickCount: 1 });
        await new Promise((r) => setTimeout(r, 1000));

        shot = await sendCommand("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync("mobile_english.png", Buffer.from(shot.data, "base64"));
        console.log(" -> Saved mobile_english.png");

        // 4. Landscape Orientation Rotation (844 x 390)
        console.log("[Test 4/4] Rotating to Landscape Mode (844x390)...");
        // Click back to QR tab first (x ~ 100, y ~ 92)
        await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 92, button: "left", clickCount: 1 });
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 92, button: "left", clickCount: 1 });
        await new Promise((r) => setTimeout(r, 500));

        await sendCommand("Emulation.setDeviceMetricsOverride", {
            width: 844,
            height: 390,
            deviceScaleFactor: 3,
            mobile: true,
            screenOrientation: { angle: 90, type: "landscapePrimary" }
        });
        await sendCommand("Runtime.evaluate", { expression: "window.dispatchEvent(new Event('resize'));" });
        await new Promise((r) => setTimeout(r, 1500));

        shot = await sendCommand("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync("mobile_landscape.png", Buffer.from(shot.data, "base64"));
        console.log(" -> Saved mobile_landscape.png");

        ws.close();
        console.log("All 4 test scenarios completed successfully!");
    } finally {
        chrome.kill("SIGKILL");
    }
}

async function main() {
    let server;
    try {
        server = await startStaticServer();
        await runTestMatrix();
    } catch (err) {
        console.error("Test Matrix error:", err);
    } finally {
        if (server) server.close();
    }
}

main();
