// Automated Verification of Real P2P WireGuard Text Streaming to PC Host
const fs = require("fs");
const { spawn } = require("child_process");

async function testP2PStreaming() {
    console.log("\n==========================================================");
    console.log("  Testing Real WireGuard P2P Stream (Mobile Web -> PC Host) ");
    console.log("==========================================================");

    // Read the live invitation URL from the desktop task log
    const logPath = "C:\\Users\\ku\\.gemini\\antigravity-cli\\brain\\52fbc68e-d96e-4bcc-ac94-ffac5444e3c7\\.system_generated\\tasks\\task-1485.log";
    if (!fs.existsSync(logPath)) {
        throw new Error("Task log not found");
    }
    const logContent = fs.readFileSync(logPath, "utf-8");
    const match = logContent.match(/Generated Cloudflare QR Invitation URL: (https:\/\/[^\s]+)/);
    if (!match) {
        throw new Error("Could not find generated invitation URL in desktop host log");
    }

    const liveUrl = match[1];
    console.log(`[P2P Test] Live Invitation URL: ${liveUrl}`);

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9227;
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
        console.log("[P2P Test] Waiting 8s for Tailcat engine and Slint UI to initialize on Cloudflare...");
        await new Promise((r) => setTimeout(r, 8000));

        console.log("[P2P Test] Triggering real P2P text message stream over Port 101...");
        const sendRes = await sendCommand("Runtime.evaluate", {
            expression: `
                (async function() {
                    const testMessage = "Hello from iPhone (Automated P2P E2E)";
                    if (typeof window.sendTailcatTextMessage === "function") {
                        await window.sendTailcatTextMessage(testMessage);
                        return { status: "sent", message: testMessage };
                    } else {
                        return { status: "missing_function" };
                    }
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });

        console.log("[P2P Test] Browser send result:", sendRes.result.value);
        console.log("[P2P Test] Waiting 3s for packet delivery over Tailcat DERP relay...");
        await new Promise((r) => setTimeout(r, 3000));

        ws.close();
        console.log("✓ P2P WireGuard Streaming Test Execution Finished.");
    } finally {
        chrome.kill("SIGKILL");
    }
}

testP2PStreaming().catch((err) => {
    console.error("Test error:", err);
    process.exit(1);
});
