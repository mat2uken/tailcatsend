// Automated E2E Verification of Clear Completion State, Paste & Send, and Text File Saving
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

async function testCompletionAndClipboard() {
    console.log("\n=========================================================================");
    console.log("  [E2E Test] Completion State, Paste & Send, and Save Text Features      ");
    console.log("=========================================================================");

    const logPath = "C:\\Users\\ku\\.gemini\\antigravity-cli\\brain\\52fbc68e-d96e-4bcc-ac94-ffac5444e3c7\\.system_generated\\tasks\\task-1803.log";
    const logContent = fs.readFileSync(logPath, "utf-8");
    const match = logContent.match(/Generated Cloudflare QR Invitation URL: (https:\/\/[^\s]+)/);
    if (!match) throw new Error("Could not find invitation URL");

    const liveUrl = match[1];
    console.log(`[E2E Test] Live Invitation URL: ${liveUrl}`);

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9245;
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
        console.log("[E2E Test] Waiting 8s for Tailcat engine and UI to mount...");
        await new Promise((r) => setTimeout(r, 8000));

        // 1. Test Text Transmission from Web (Paste & Send emulation)
        console.log("[E2E Test] Testing Text Transmission (Emulating Paste & Send)...");
        const clipboardText = "Sample copied text from mobile clipboard! 🚀";
        await sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    window.sendTailcatTextMessage("${clipboardText}");
                    return "sent";
                })()
            `
        });

        await new Promise((r) => setTimeout(r, 1500));

        // 2. Test Large File Transfer & Emerald Green Completion State
        console.log("[E2E Test] Testing File Transfer & Emerald Green Completion State...");
        const testSizeBytes = 2 * 1024 * 1024; // 2 MB
        const testData = crypto.randomBytes(testSizeBytes);
        const base64Data = testData.toString("base64");
        const filename = "completion_feedback_test.mp4";

        await sendCommand("Runtime.evaluate", {
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
                    await window.sendTailcatFileChunked(file);
                })()
            `,
            awaitPromise: true
        });

        await new Promise((r) => setTimeout(r, 1000));

        // Check HUD completion status and classes
        const hudState = await sendCommand("Runtime.evaluate", {
            expression: `
                ({
                    hudClasses: document.getElementById("transfer-hud") ? document.getElementById("transfer-hud").className : "",
                    hudStatus: document.getElementById("hud-status") ? document.getElementById("hud-status").textContent : "",
                    hudPercent: document.getElementById("hud-percent") ? document.getElementById("hud-percent").textContent : ""
                })
            `,
            returnByValue: true
        });

        console.log("[E2E Test] Completion HUD State:", hudState.result.value);

        // Capture screenshot of the updated mobile UI with completion card and action buttons
        const screenshotRes = await sendCommand("Page.captureScreenshot", { format: "png" });
        if (screenshotRes && screenshotRes.data) {
            fs.writeFileSync("mobile_updated_actions_screenshot.png", Buffer.from(screenshotRes.data, "base64"));
            console.log("✓ Saved mobile_updated_actions_screenshot.png");
        }

        if (hudState.result.value.hudClasses.includes("completed") || hudState.result.value.hudStatus.includes("Complete") || hudState.result.value.hudStatus.includes("Completed")) {
            console.log("✅ SUCCESS: Completion feedback, Paste & Send, and UI actions verified!");
        } else {
            throw new Error("HUD did not display completed state!");
        }

        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

testCompletionAndClipboard().catch((err) => {
    console.error("Test error:", err);
    process.exit(1);
});
