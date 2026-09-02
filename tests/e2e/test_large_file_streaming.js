// Comprehensive Automated E2E Test for Large File Slice Streaming (Mobile -> PC) with SHA-256 Verification
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

async function testLargeFileStreaming() {
    console.log("\n=========================================================================");
    console.log("  [E2E Test] Large File On-Demand Chunked Streaming (Mobile -> PC Host) ");
    console.log("=========================================================================");

    const logPath = "C:\\Users\\ku\\.gemini\\antigravity-cli\\brain\\52fbc68e-d96e-4bcc-ac94-ffac5444e3c7\\.system_generated\\tasks\\task-1611.log";
    if (!fs.existsSync(logPath)) throw new Error("Desktop task log not found");

    const logContent = fs.readFileSync(logPath, "utf-8");
    const match = logContent.match(/Generated Cloudflare QR Invitation URL: (https:\/\/[^\s]+)/);
    if (!match) throw new Error("Could not find invitation URL");

    const liveUrl = match[1];
    console.log(`[Large File Test] Live Invitation URL: ${liveUrl}`);

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9235;
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
        console.log("[Large File Test] Waiting 8s for Tailcat engine and UI to mount (Fresh Cache-Busted Load)...");
        await new Promise((r) => setTimeout(r, 8000));

        // Generate 4 MB test video payload
        const testSizeBytes = 4 * 1024 * 1024; // 4,194,304 bytes (64 chunks of 64KB)
        const testData = crypto.randomBytes(testSizeBytes);
        const expectedSha256 = crypto.createHash("sha256").update(testData).digest("hex");
        const filename = "iphone_large_movie_recording.mp4";

        console.log(`[Large File Test] Generated payload: ${filename} (${(testSizeBytes / 1048576).toFixed(1)} MB)`);
        console.log(`[Large File Test] Expected SHA-256: ${expectedSha256}`);

        // Stream via slice
        const base64Data = testData.toString("base64");
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

        console.log("[Large File Test] Browser send response:", sendRes.result.value);
        console.log("[Large File Test] Waiting 5s for PC disk write...");
        await new Promise((r) => setTimeout(r, 5000));

        // Validate file on PC disk
        const downloadDir = path.join(os.homedir(), "Downloads", "TailSend");
        const savedFilePath = path.join(downloadDir, filename);

        if (!fs.existsSync(savedFilePath)) {
            throw new Error(`File was not saved to expected path: ${savedFilePath}`);
        }

        const savedBytes = fs.readFileSync(savedFilePath);
        const actualSha256 = crypto.createHash("sha256").update(savedBytes).digest("hex");

        console.log(`[Large File Test] Saved file path: ${savedFilePath}`);
        console.log(`[Large File Test] Saved file size: ${savedBytes.length} bytes (Expected: ${testSizeBytes})`);
        console.log(`[Large File Test] Actual SHA-256:   ${actualSha256}`);

        if (actualSha256 === expectedSha256 && savedBytes.length === testSizeBytes) {
            console.log("✅ SUCCESS: Large file on-demand slice streaming completed with 100% SHA-256 integrity!");
        } else {
            throw new Error("Checksum mismatch or size difference on received file!");
        }

        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

testLargeFileStreaming().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
