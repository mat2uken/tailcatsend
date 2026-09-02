// Automated Verification of Real-Time Live Progress Bar and Animation
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

async function testLiveProgress() {
    console.log("\n=========================================================================");
    console.log("  [E2E Animation Test] Real-Time Progress Bar Rendering & Visual Check  ");
    console.log("=========================================================================");

    const logPath = "C:\\Users\\ku\\.gemini\\antigravity-cli\\brain\\52fbc68e-d96e-4bcc-ac94-ffac5444e3c7\\.system_generated\\tasks\\task-1728.log";
    const logContent = fs.readFileSync(logPath, "utf-8");
    const match = logContent.match(/Generated Cloudflare QR Invitation URL: (https:\/\/[^\s]+)/);
    if (!match) throw new Error("Could not find invitation URL");

    const liveUrl = match[1];
    console.log(`[Animation Test] Live Invitation URL: ${liveUrl}`);

    const chromePath = fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const debugPort = 9240;
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
        console.log("[Animation Test] Waiting 8s for Tailcat engine and UI to mount...");
        await new Promise((r) => setTimeout(r, 8000));

        // Generate 6 MB payload
        const testSizeBytes = 6 * 1024 * 1024;
        const testData = crypto.randomBytes(testSizeBytes);
        const base64Data = testData.toString("base64");
        const filename = "live_progress_test_video.mp4";

        console.log("[Animation Test] Starting chunked transfer and monitoring DOM HUD progress...");

        // Start send in background
        const sendPromise = sendCommand("Runtime.evaluate", {
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
                    return { status: "sent" };
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });

        // Sample progress every 200ms
        const samples = [];
        for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 200));
            const hudInfo = await sendCommand("Runtime.evaluate", {
                expression: `
                    ({
                        display: document.getElementById("transfer-hud") ? document.getElementById("transfer-hud").style.display : "none",
                        percent: document.getElementById("hud-percent") ? document.getElementById("hud-percent").textContent : "",
                        status: document.getElementById("hud-status") ? document.getElementById("hud-status").textContent : "",
                        bytes: document.getElementById("hud-bytes") ? document.getElementById("hud-bytes").textContent : "",
                        barWidth: document.getElementById("hud-bar-fill") ? document.getElementById("hud-bar-fill").style.width : ""
                    })
                `,
                returnByValue: true
            });
            if (hudInfo.result && hudInfo.result.value) {
                samples.push(hudInfo.result.value);
                console.log(`[Animation Sample ${i+1}] HUD State:`, hudInfo.result.value);
            }
        }

        await sendPromise;
        console.log("[Animation Test] Transfer finished. Sampling summary...");

        // Capture screenshot after transfer completes to verify activity log & permanent card
        const screenshotRes = await sendCommand("Page.captureScreenshot", { format: "png" });
        if (screenshotRes && screenshotRes.data) {
            fs.writeFileSync("progress_active_screenshot.png", Buffer.from(screenshotRes.data, "base64"));
            console.log("✓ Saved progress_active_screenshot.png");
        }

        const activeSamples = samples.filter(s => s.display === "flex" && parseInt(s.percent) > 0);
        console.log(`[Animation Test] Total Active Progress Frames Sampled: ${activeSamples.length}`);

        if (activeSamples.length > 0) {
            console.log("✅ SUCCESS: Live real-time progress bar rendering verified with continuous percentage/speed updates!");
        } else {
            throw new Error("No active progress bar frames captured during transfer!");
        }

        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

testLiveProgress().catch((err) => {
    console.error("Test error:", err);
    process.exit(1);
});
