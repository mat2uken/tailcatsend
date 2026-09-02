// Comprehensive Automated E2E Test: 64KiB Chunked Streaming (PC -> Mobile) with Download Event Verification
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

async function testPcToMobileTransfer() {
    console.log("\n=================================================================");
    console.log("  [E2E Test 2] PC -> Mobile Chunked Transfer & Browser Download  ");
    console.log("=================================================================");

    const logPath = "C:\\Users\\ku\\.gemini\\antigravity-cli\\brain\\52fbc68e-d96e-4bcc-ac94-ffac5444e3c7\\.system_generated\\tasks\\task-1559.log";
    const logContent = fs.readFileSync(logPath, "utf-8");
    const match = logContent.match(/Generated Cloudflare QR Invitation URL: (https:\/\/[^\s]+)/);
    if (!match) throw new Error("Could not find invitation URL");

    const liveUrl = match[1];
    console.log(`[PC->Mobile Test] Live Invitation URL: ${liveUrl}`);

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9231;
    const chrome = spawn(chromePath, [
        "--headless=new",
        `--remote-debugging-port=${debugPort}`,
        "--disable-gpu",
        "--no-sandbox",
        liveUrl,
    ]);

    try {
        await new Promise((r) => setTimeout(r, 2500));
        const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await targetsRes.json();
        const pageTarget = targets.find((t) => t.type === "page");
        if (!pageTarget) throw new Error("No page target found");

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
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.id && pending.has(data.id)) {
                const resolve = pending.get(data.id);
                pending.delete(data.id);
                resolve(data.result);
            }
            if (data.method === "Runtime.consoleAPICalled") {
                const text = data.params.args.map((a) => a.value || a.description || "").join(" ");
                console.log(`[Browser ${data.params.type}]`, text);
            }
        };

        await sendCommand("Runtime.enable");
        console.log("[PC->Mobile Test] Waiting 8s for Tailcat engine and UI to mount...");
        await new Promise((r) => setTimeout(r, 8000));

        // Generate 256 KiB document data
        const testData = crypto.randomBytes(256 * 1024); // 262,144 bytes
        const expectedSha256 = crypto.createHash("sha256").update(testData).digest("hex");
        const base64Data = testData.toString("base64");
        const filename = "pc_presentation_slides.pdf";

        console.log(`[PC->Mobile Test] Generated test payload: ${filename} (262,144 bytes, 4 chunks of 64KB)`);
        console.log(`[PC->Mobile Test] Expected SHA-256: ${expectedSha256}`);

        // Set up download interception listener in browser
        await sendCommand("Runtime.evaluate", {
            expression: `
                window.interceptedDownloads = [];
                const origCreateObjectURL = URL.createObjectURL;
                URL.createObjectURL = function(blob) {
                    const url = origCreateObjectURL.call(URL, blob);
                    window.interceptedDownloads.push({ size: blob.size, type: blob.type });
                    return url;
                };
            `
        });

        // Connect as Host role to Edge Relay and stream the chunks to the browser
        const sessionTokenMatch = liveUrl.match(/i=([^&]+)/);
        const sessionId = sessionTokenMatch[1].slice(0, 32);
        const relayWsUrl = `wss://tailsend-poc.mat2uken.workers.dev/relay?session=${encodeURIComponent(sessionId)}&role=host`;

        console.log("[PC->Mobile Test] Connecting Node.js sender to Edge Relay as Host:", relayWsUrl);
        const hostWs = new WebSocket(relayWsUrl);
        await new Promise((r) => hostWs.onopen = r);

        const fileId = "test-doc-123";
        const CHUNK_SIZE = 64 * 1024;
        const totalChunks = Math.ceil(testData.length / CHUNK_SIZE);

        // 1. Send file_start
        hostWs.send(JSON.stringify({
            type: "file_start",
            channel: 102,
            fileId: fileId,
            filename: filename,
            totalBytes: testData.length,
            totalChunks: totalChunks,
            timestamp: Date.now()
        }));

        // 2. Send 64 KiB chunks
        for (let i = 0; i < totalChunks; i++) {
            const chunkSlice = testData.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, testData.length));
            hostWs.send(JSON.stringify({
                type: "file_chunk",
                channel: 102,
                fileId: fileId,
                chunkIndex: i,
                data: chunkSlice.toString("base64")
            }));
            await new Promise((r) => setTimeout(r, 20));
        }

        // 3. Send file_complete
        hostWs.send(JSON.stringify({
            type: "file_complete",
            channel: 102,
            fileId: fileId
        }));

        console.log("[PC->Mobile Test] File stream dispatched from Host. Waiting 3s for browser completion...");
        await new Promise((r) => setTimeout(r, 3000));

        // Check browser intercepted downloads
        const downloadCheck = await sendCommand("Runtime.evaluate", {
            expression: `window.interceptedDownloads`,
            returnByValue: true
        });

        console.log("[PC->Mobile Test] Browser intercepted downloads:", downloadCheck.result.value);

        if (downloadCheck.result.value && downloadCheck.result.value.length > 0 && downloadCheck.result.value[0].size === testData.length) {
            console.log("✅ SUCCESS: PC -> Mobile chunked transfer completed and triggered automatic browser download!");
        } else {
            throw new Error("Browser did not trigger download with expected file size!");
        }

        hostWs.close();
        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

testPcToMobileTransfer().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
