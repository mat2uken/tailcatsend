// Comprehensive Real WireGuard P2P E2E Verification Script
// Tests full bidirectional communication: PC Host <-> Mobile Web (Joiner)
const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

const DIST_DIR = path.resolve(__dirname, "../../dist");
const HTTP_PORT = 8795;
const DAEMON_IPC_PORT = 49185;

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

async function runBidirectionalP2PTest() {
    console.log("\n================================================================");
    console.log("  [Deep Verification] Real WireGuard P2P Bidirectional Transfer ");
    console.log("  Host (PC Daemon) <===> Joiner (Mobile Web / Chrome Headless)  ");
    console.log("================================================================");

    let server = null;
    let daemon = null;
    let chrome = null;
    let ipcSocket = null;

    try {
        server = await startStaticServer();

        // 1. Spawn Host tailcat_daemon
        const daemonPath = fs.existsSync(path.resolve(__dirname, "../../tailcat_daemon"))
            ? path.resolve(__dirname, "../../tailcat_daemon")
            : path.resolve(__dirname, "../../target/release/tailcat_daemon.exe");
        console.log(`[Host Daemon] Spawning: ${daemonPath}`);
        daemon = spawn(daemonPath, [
            "-derp=https://tailcat.dev/derpmap.json",
            `-ipc-port=${DAEMON_IPC_PORT}`,
            "-v"
        ]);

        let hostAddress = "";
        let pairedJoinerAddress = "";
        const daemonEvents = [];

        daemon.stdout.on("data", (data) => {
            const lines = data.toString().split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                console.log(`[Host Daemon stdout] ${trimmed}`);
                try {
                    const ev = JSON.parse(trimmed);
                    daemonEvents.push(ev);
                    if (ev.event === "ready" && ev.address) {
                        hostAddress = ev.address;
                    }
                    if (ev.event === "incoming_text" && ev.text) {
                        if (ev.text.includes("JOIN:")) {
                            const parts = ev.text.split("JOIN:");
                            if (parts.length > 1) {
                                pairedJoinerAddress = parts[1].trim().split(/\s+/)[0];
                                console.log(`🔗 [Host Daemon] Acquired Joiner address: ${pairedJoinerAddress}`);
                            }
                        }
                    }
                } catch (_) {}
            }
        });

        daemon.stderr.on("data", (data) => {
            console.log(`[Host Daemon stderr] ${data.toString().trim()}`);
        });

        console.log("[Host Daemon] Waiting for Host WireGuard address...");
        for (let i = 0; i < 30; i++) {
            if (hostAddress) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        if (!hostAddress) {
            throw new Error("Failed to acquire Host WireGuard address within 15 seconds");
        }
        console.log(`⚡ [Host Daemon] Acquired Host Address: ${hostAddress}`);

        // 2. Connect to Daemon IPC
        await new Promise((r) => setTimeout(r, 1000));
        ipcSocket = net.connect(DAEMON_IPC_PORT, "127.0.0.1");
        await new Promise((resolve, reject) => {
            ipcSocket.on("connect", resolve);
            ipcSocket.on("error", reject);
        });
        console.log(`⚡ [Host IPC] Connected to Host Daemon IPC Port ${DAEMON_IPC_PORT}`);

        ipcSocket.on("data", (data) => {
            const lines = data.toString().split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) console.log(`[Host IPC Response] ${trimmed}`);
            }
        });

        // 3. Generate Invitation Token using gen_token example
        const genTokenExe = path.resolve(__dirname, "../../target/debug/examples/gen_token.exe");
        let inviteToken = "";
        if (fs.existsSync(genTokenExe)) {
            inviteToken = execSync(`"${genTokenExe}" "${hostAddress}"`).toString().trim();
        } else {
            inviteToken = execSync(`cargo run -p tailsend-protocol --example gen_token "${hostAddress}"`).toString().trim();
            const tokenLines = inviteToken.split("\n");
            inviteToken = tokenLines[tokenLines.length - 1].trim();
        }
        console.log(`🔑 [Invitation Token] Generated: ${inviteToken.slice(0, 30)}...`);

        const mobileUrl = `http://127.0.0.1:${HTTP_PORT}/index.html#i=${inviteToken}`;
        console.log(`📱 [Mobile Web URL] Target: ${mobileUrl}`);

        // 4. Launch Chrome Headless simulating Mobile Smartphone
        const chromePath = fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
            ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            : fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
            ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
            : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

        const debugPort = 9235;
        chrome = spawn(chromePath, [
            "--headless=new",
            `--remote-debugging-port=${debugPort}`,
            "--enable-webgl",
            "--no-sandbox",
            mobileUrl,
        ]);

        await new Promise((r) => setTimeout(r, 2000));
        const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await targetsRes.json();
        const pageTarget = targets.find((t) => t.type === "page");
        if (!pageTarget) throw new Error("No Chrome page target found");

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

        await new Promise((resolve) => ws.onopen = resolve);
        const browserLogs = [];
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.id && pending.has(data.id)) {
                const resolve = pending.get(data.id);
                pending.delete(data.id);
                resolve(data.result);
            }
            if (data.method === "Runtime.consoleAPICalled") {
                const text = data.params.args.map((a) => a.value || a.description || "").join(" ");
                browserLogs.push(text);
                console.log(`[Browser Console] ${text}`);
            }
        };

        await sendCommand("Runtime.enable");
        console.log("[Mobile Web] Waiting 8s for Tailcat engine, listener creation & handshake...");
        await new Promise((r) => setTimeout(r, 8000));

        // Intercept browser downloads
        await sendCommand("Runtime.evaluate", {
            expression: `
                window.interceptedDownloads = [];
                const origCreateObjectURL = URL.createObjectURL;
                URL.createObjectURL = function(blob) {
                    const url = origCreateObjectURL.call(URL, blob);
                    blob.arrayBuffer().then(buf => {
                        crypto.subtle.digest("SHA-256", buf).then(hash => {
                            const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
                            window.interceptedDownloads.push({
                                size: blob.size,
                                type: blob.type,
                                sha256: hex
                            });
                            console.log("[Browser Download Intercepted] Size: " + blob.size + " bytes, SHA-256: " + hex);
                        });
                    });
                    return url;
                };
            `
        });

        // 5. Verify Joiner listener was established and Host received Joiner address
        console.log("\n--- Verification Phase 1: Joiner Address Exchange ---");
        for (let i = 0; i < 25; i++) {
            if (pairedJoinerAddress) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        if (!pairedJoinerAddress) {
            const ownAddrRes = await sendCommand("Runtime.evaluate", {
                expression: "window.ownTailcatAddress || ''",
                returnByValue: true
            });
            console.log("Browser ownTailcatAddress:", ownAddrRes.result.value);
            throw new Error("Host did not receive Joiner address via JOIN: handshake!");
        }
        console.log(`✓ Verification 1 PASSED: Host successfully paired with Joiner address: ${pairedJoinerAddress}`);

        // 6. Test Host -> Joiner (Mobile Web) Text Message Transmission!
        console.log("\n--- Verification Phase 2: Host -> Joiner Text Message ---");
        const testTextMessage = "Hello from Host PC! (Direct P2P Verification 2026)";
        const sendTextCmd = JSON.stringify({
            action: "send_text",
            address: pairedJoinerAddress,
            port: 101,
            text: testTextMessage
        }) + "\n";
        ipcSocket.write(sendTextCmd);

        console.log("[Host -> Joiner] Text command sent over IPC, waiting for delivery...");
        let receivedText = "";
        for (let i = 0; i < 25; i++) {
            await new Promise((r) => setTimeout(r, 400));
            const checkRes = await sendCommand("Runtime.evaluate", {
                expression: "window.lastReceivedMessage || ''",
                returnByValue: true
            });
            if (checkRes.result && checkRes.result.value) {
                receivedText = checkRes.result.value;
                break;
            }
        }
        console.log(`[Mobile Web] lastReceivedMessage in browser: "${receivedText}"`);
        if (!receivedText.includes(testTextMessage)) {
            throw new Error(`Text message was not received by Mobile Web! Got: "${receivedText}"`);
        }
        console.log("✓ Verification 2 PASSED: Mobile Web successfully received text message sent from Host PC!");

        // 7. Test Host -> Joiner (Mobile Web) File Transfer!
        console.log("\n--- Verification Phase 3: Host -> Joiner File Transfer ---");
        const tempTestDir = path.resolve(__dirname, "../../target");
        const testFilePath = path.join(tempTestDir, "test_p2p_file.bin");
        const testFileContent = Buffer.alloc(128 * 1024); // 128 KiB test payload
        for (let i = 0; i < testFileContent.length; i++) {
            testFileContent[i] = (i % 256);
        }
        fs.writeFileSync(testFilePath, testFileContent);
        const expectedSha256 = crypto.createHash("sha256").update(testFileContent).digest("hex");
        console.log(`[Host] Created test file: ${testFilePath} (${testFileContent.length} bytes)`);
        console.log(`[Host] Expected SHA-256: ${expectedSha256}`);

        const sendFileCmd = JSON.stringify({
            action: "send_file",
            address: pairedJoinerAddress,
            port: 102,
            filename: "test_p2p_file.bin",
            path: testFilePath
        }) + "\n";
        ipcSocket.write(sendFileCmd);

        console.log("[Host -> Joiner] File command sent over IPC, waiting for stream delivery & download...");
        let downloadSuccess = false;
        let downloadedSize = 0;
        let downloadedSha256 = "";

        for (let i = 0; i < 35; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const checkDlRes = await sendCommand("Runtime.evaluate", {
                expression: `JSON.stringify(window.interceptedDownloads || [])`,
                returnByValue: true
            });
            if (checkDlRes.result && checkDlRes.result.value) {
                const downloads = JSON.parse(checkDlRes.result.value);
                if (downloads.length > 0 && downloads[0].sha256) {
                    downloadedSize = downloads[0].size;
                    downloadedSha256 = downloads[0].sha256;
                    if (downloadedSize === testFileContent.length) {
                        downloadSuccess = true;
                        break;
                    }
                }
            }
        }

        console.log(`[Mobile Web] Intercepted download size: ${downloadedSize} bytes (Expected: ${testFileContent.length})`);
        console.log(`[Mobile Web] Intercepted download SHA-256: ${downloadedSha256}`);
        if (!downloadSuccess || downloadedSize !== testFileContent.length) {
            throw new Error(`File was not received or size mismatch! Received: ${downloadedSize}, Expected: ${testFileContent.length}`);
        }
        if (downloadedSha256 !== expectedSha256) {
            throw new Error(`SHA-256 mismatch! Received: ${downloadedSha256}, Expected: ${expectedSha256}`);
        }
        console.log("✓ Verification 3 PASSED: Mobile Web successfully received and downloaded file sent from Host PC with 100% SHA-256 integrity!");

        // 8. Test Joiner (Mobile Web) -> Host Text Message Transmission (Reverse path)!
        console.log("\n--- Verification Phase 4: Joiner -> Host Text Reply ---");
        const replyText = "Reply from Mobile Phone: WireGuard P2P is fully bidirectional!";
        const browserSendRes = await sendCommand("Runtime.evaluate", {
            expression: `
                (async function() {
                    if (typeof window.sendTailcatTextMessage === "function") {
                        await window.sendTailcatTextMessage("${replyText}");
                        return true;
                    }
                    return false;
                })()
            `,
            awaitPromise: true,
            returnByValue: true
        });

        console.log("[Joiner -> Host] Reply triggered, checking Host daemon events...");
        let hostReceivedReply = false;
        for (let i = 0; i < 25; i++) {
            await new Promise((r) => setTimeout(r, 400));
            for (const ev of daemonEvents) {
                if (ev.event === "incoming_text" && ev.text && ev.text.includes(replyText)) {
                    hostReceivedReply = true;
                    break;
                }
            }
            if (hostReceivedReply) break;
        }

        if (!hostReceivedReply) {
            throw new Error("Host Daemon did not receive reply from Mobile Web!");
        }
        console.log("✓ Verification 4 PASSED: Host Daemon successfully received reply sent from Mobile Web!");

        console.log("\n================================================================");
        console.log("  🎉 ALL 4 REAL WIREGUARD P2P TESTS PASSED 100%!                ");
        console.log("  - Handshake & Automatic Peer Address Pairing: OK              ");
        console.log("  - Host PC -> Mobile Web Text Message Streaming: OK            ");
        console.log("  - Host PC -> Mobile Web 128KB File Stream & Download: OK      ");
        console.log("  - Mobile Web -> Host PC Reverse Text Streaming: OK            ");
        console.log("================================================================\n");

        ws.close();
    } finally {
        if (chrome) chrome.kill("SIGKILL");
        if (ipcSocket) ipcSocket.destroy();
        if (daemon) daemon.kill("SIGKILL");
        if (server) server.close();
    }
}

runBidirectionalP2PTest().catch((err) => {
    console.error("\n❌ BIDIRECTIONAL P2P TEST FAILED:", err);
    process.exit(1);
});
