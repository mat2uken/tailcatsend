// Comprehensive Automated E2E Test: 64KiB Chunked Streaming (Mobile -> PC) with Checksum Validation
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

async function testChunkedUpload() {
    console.log("\n=================================================================");
    console.log("  [E2E Test 1] Mobile -> PC 64KiB Chunked Streaming & SHA-256   ");
    console.log("=================================================================");

    const logPath = "C:\\Users\\ku\\.gemini\\antigravity-cli\\brain\\52fbc68e-d96e-4bcc-ac94-ffac5444e3c7\\.system_generated\\tasks\\task-1559.log";
    if (!fs.existsSync(logPath)) throw new Error("Desktop task log not found");

    const logContent = fs.readFileSync(logPath, "utf-8");
    const match = logContent.match(/Generated Cloudflare QR Invitation URL: (https:\/\/[^\s]+)/);
    if (!match) throw new Error("Could not find invitation URL");

    const liveUrl = match[1];
    console.log(`[Chunked Test] Live Invitation URL: ${liveUrl}`);

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9230;
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
        console.log("[Chunked Test] Waiting 8s for Tailcat engine and UI to mount...");
        await new Promise((r) => setTimeout(r, 8000));

        // Generate 512 KiB random test binary data
        const testData = crypto.randomBytes(512 * 1024); // 524,288 bytes
        const expectedSha256 = crypto.createHash("sha256").update(testData).digest("hex");
        const base64Data = testData.toString("base64");
        const filename = "chunked_test_video.mp4";

        console.log(`[Chunked Test] Test payload generated: ${filename} (524,288 bytes, 8 chunks of 64KB)`);
        console.log(`[Chunked Test] Expected SHA-256: ${expectedSha256}`);

        const sendRes = await sendCommand("Runtime.evaluate", {
            expression: `
                (async function() {
                    const b64 = "${base64Data}";
                    const binary = atob(b64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        bytes[i] = binary.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: "video/mp4" });
                    const file = new File([blob], "${filename}", { type: "video/mp4" });

                    if (typeof window.sendTailcatFileChunked === "function") {
                        await window.sendTailcatFileChunked(file);
                        return { status: "sent", name: file.name, size: file.size };
                    } else {
                        return { status: "missing_function" };
                    }
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });

        console.log("[Chunked Test] Browser send response:", sendRes.result.value);
        console.log("[Chunked Test] Waiting 3s for PC disk write...");
        await new Promise((r) => setTimeout(r, 3000));

        // Validate file on PC disk
        const downloadDir = path.join(os.homedir(), "Downloads", "TailSend");
        const savedFilePath = path.join(downloadDir, filename);

        if (!fs.existsSync(savedFilePath)) {
            throw new Error(`File was not saved to expected path: ${savedFilePath}`);
        }

        const savedBytes = fs.readFileSync(savedFilePath);
        const actualSha256 = crypto.createHash("sha256").update(savedBytes).digest("hex");

        console.log(`[Chunked Test] Saved file path: ${savedFilePath}`);
        console.log(`[Chunked Test] Saved file size: ${savedBytes.length} bytes (Expected: ${testData.length})`);
        console.log(`[Chunked Test] Actual SHA-256:   ${actualSha256}`);

        if (actualSha256 === expectedSha256 && savedBytes.length === testData.length) {
            console.log("✅ SUCCESS: 64KiB chunked streaming transfer completed with 100% SHA-256 integrity!");
        } else {
            throw new Error("Checksum mismatch or size difference on received file!");
        }

        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

testChunkedUpload().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
