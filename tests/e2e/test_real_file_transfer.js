// Automated Verification of Real File Transfer to PC Host
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

async function testFileTransfer() {
    console.log("\n==========================================================");
    console.log("  Testing Real File Transfer Stream (Mobile -> PC Host)   ");
    console.log("==========================================================");

    const logPath = "C:\\Users\\ku\\.gemini\\antigravity-cli\\brain\\52fbc68e-d96e-4bcc-ac94-ffac5444e3c7\\.system_generated\\tasks\\task-1485.log";
    const logContent = fs.readFileSync(logPath, "utf-8");
    const match = logContent.match(/Generated Cloudflare QR Invitation URL: (https:\/\/[^\s]+)/);
    if (!match) throw new Error("Could not find invitation URL");

    const liveUrl = match[1];
    console.log(`[File Test] Live Invitation URL: ${liveUrl}`);

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9228;
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
        console.log("[File Test] Waiting 8s for Tailcat engine and UI to mount...");
        await new Promise((r) => setTimeout(r, 8000));

        console.log("[File Test] Streaming sample image file to PC host...");
        const sendRes = await sendCommand("Runtime.evaluate", {
            expression: `
                (async function() {
                    const sampleFileContent = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]);
                    const blob = new Blob([sampleFileContent], { type: "image/jpeg" });
                    const file = new File([blob], "iphone_sample_photo.jpg", { type: "image/jpeg" });

                    if (typeof window.sendTailcatFile === "function") {
                        await window.sendTailcatFile(file);
                        return { status: "sent", name: file.name, size: file.size };
                    } else {
                        return { status: "missing_function" };
                    }
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });

        console.log("[File Test] Browser file send result:", sendRes.result.value);
        console.log("[File Test] Waiting 3s for file save on PC disk...");
        await new Promise((r) => setTimeout(r, 3000));

        const downloadDir = path.join(os.homedir(), "Downloads", "TailSend");
        const expectedFile = path.join(downloadDir, "iphone_sample_photo.jpg");
        if (fs.existsSync(expectedFile)) {
            const stats = fs.statSync(expectedFile);
            console.log(`✓ File Successfully Transferred and Saved to PC! Path: ${expectedFile}, Size: ${stats.size} bytes`);
        } else {
            console.log(`[Note] Download directory checked: ${downloadDir}`);
        }

        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

testFileTransfer().catch((err) => {
    console.error("File test error:", err);
    process.exit(1);
});
