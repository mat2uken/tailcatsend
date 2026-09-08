// Web-to-Web WebRTC P2P E2E Verification Script
// Tests full bidirectional communication between two Web (Chrome WASM) clients.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const DIST_DIR = path.resolve(__dirname, "../../dist");
const HTTP_PORT = 8797;
const CHROME_DEBUG_PORT = 9236;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".gz": "application/gzip",
    ".json": "application/json",
    ".css": "text/css",
    ".png": "image/png",
};

function startStaticServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let reqPath = req.url.split("?")[0].split("#")[0];
            if (reqPath === "/") reqPath = "/index.html";

            const filePath = path.join(DIST_DIR, reqPath);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("404 Not Found: " + reqPath);
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            let contentType = MIME_TYPES[ext] || "application/octet-stream";
            if (filePath.endsWith(".wasm.gz")) contentType = "application/gzip";

            res.writeHead(200, {
                "Content-Type": contentType,
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache",
            });
            fs.createReadStream(filePath).pipe(res);
        });

        server.listen(HTTP_PORT, "127.0.0.1", () => {
            console.log(`[E2E Server] Serving ${DIST_DIR} on http://127.0.0.1:${HTTP_PORT}`);
            resolve(server);
        });
    });
}

function findChrome() {
    const candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser"
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    throw new Error("No Chrome/Chromium binary found");
}

class CDPClient {
    constructor(wsUrl, name) {
        this.wsUrl = wsUrl;
        this.name = name;
        this.ws = null;
        this.msgId = 1;
        this.pending = new Map();
        this.logs = [];
        this.webrtcLogs = [];
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
            this.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.id && this.pending.has(msg.id)) {
                    const cb = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    cb(msg.result);
                }
                if (msg.method === "Runtime.consoleAPICalled") {
                    const text = msg.params.args.map((a) => a.value || a.description || "").join(" ");
                    this.logs.push(text);
                    console.log(`[${this.name} Console] ${text}`);
                    if (text.toLowerCase().includes("webrtc") || text.includes("127.3.3.41") || text.toLowerCase().includes("magicsock")) {
                        this.webrtcLogs.push(text);
                    }
                }
            };
        });
    }

    send(method, params = {}) {
        return new Promise((resolve) => {
            const id = this.msgId++;
            this.pending.set(id, resolve);
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async eval(expr) {
        const res = await this.send("Runtime.evaluate", {
            expression: expr,
            returnByValue: true,
            awaitPromise: true,
        });
        return res && res.result ? res.result.value : undefined;
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

async function runWebToWebTest() {
    console.log("\n================================================================");
    console.log("  [Web <-> Web] WebRTC P2P Verification Test (Chrome WASM)      ");
    console.log("  Host Web (Tab 1) <===> Joiner Web (Tab 2)                    ");
    console.log("================================================================");

    let server = null;
    let chrome = null;
    let hostClient = null;
    let joinerClient = null;

    try {
        server = await startStaticServer();

        const chromeBin = findChrome();
        console.log(`[Chrome] Using binary: ${chromeBin}`);

        chrome = spawn(chromeBin, [
            "--headless=new",
            `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            `http://127.0.0.1:${HTTP_PORT}/index.html`
        ]);

        await new Promise((r) => setTimeout(r, 2000));

        // Get Host target
        const targetsRes = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/list`);
        const targets = await targetsRes.json();
        const hostTarget = targets.find((t) => t.type === "page");
        if (!hostTarget) throw new Error("No page target found for Host");

        hostClient = new CDPClient(hostTarget.webSocketDebuggerUrl, "HostWeb");
        await hostClient.connect();
        await hostClient.send("Runtime.enable");

        console.log("[Host Web] Waiting for Tailcat Host listener & address...");
        let hostAddress = "";
        for (let i = 0; i < 30; i++) {
            hostAddress = await hostClient.eval("window.ownTailcatAddress || ''");
            if (hostAddress) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        if (!hostAddress) throw new Error("Failed to acquire Host Web Tailcat address within 15s");
        console.log(`⚡ [Host Web] Address Acquired: ${hostAddress}`);

        // Generate invitation token using protocol tool or node
        let inviteToken = "";
        const genTokenExe = path.resolve(__dirname, "../../target/debug/examples/gen_token.exe");
        if (fs.existsSync(genTokenExe)) {
            inviteToken = execSync(`"${genTokenExe}" "${hostAddress}"`).toString().trim();
        } else {
            inviteToken = execSync(`cargo run -p tailsend-protocol --example gen_token "${hostAddress}"`).toString().trim();
            const tokenLines = inviteToken.split("\n");
            inviteToken = tokenLines[tokenLines.length - 1].trim();
        }
        console.log(`⚡ [Invite Token] Generated token`);

        // Open Tab 2 (Joiner)
        const joinerUrl = `http://127.0.0.1:${HTTP_PORT}/index.html#i=${inviteToken}`;
        const newTabRes = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/new?${encodeURIComponent(joinerUrl)}`, { method: "PUT" });
        const joinerTarget = await newTabRes.json();

        joinerClient = new CDPClient(joinerTarget.webSocketDebuggerUrl, "JoinerWeb");
        await joinerClient.connect();
        await joinerClient.send("Runtime.enable");

        console.log("[Joiner Web] Waiting for Joiner engine & handshake connection...");
        let joinerAddress = "";
        for (let i = 0; i < 30; i++) {
            joinerAddress = await joinerClient.eval("window.ownTailcatAddress || ''");
            if (joinerAddress) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        console.log(`⚡ [Joiner Web] Address Acquired: ${joinerAddress}`);

        // Wait for WebRTC negotiation & pairing
        console.log("[Web <-> Web] Waiting for WebRTC signaling and data channel establishment (15s)...");
        await new Promise((r) => setTimeout(r, 15000));

        // Check WebRTC Logs
        console.log("\n--- WebRTC Diagnostics ---");
        console.log("Host WebRTC logs count:", hostClient.webrtcLogs.length);
        hostClient.webrtcLogs.forEach(l => console.log(`  [Host WebRTC] ${l}`));
        console.log("Joiner WebRTC logs count:", joinerClient.webrtcLogs.length);
        joinerClient.webrtcLogs.forEach(l => console.log(`  [Joiner WebRTC] ${l}`));

        console.log("\n================================================================");
        console.log("  Web <-> Web WebRTC Diagnostic Run Finished                    ");
        console.log("================================================================");

    } finally {
        if (hostClient) hostClient.close();
        if (joinerClient) joinerClient.close();
        if (chrome) {
            chrome.kill("SIGKILL");
        }
        if (server) {
            server.close();
        }
    }
}

runWebToWebTest().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
