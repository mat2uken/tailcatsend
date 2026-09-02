// E2E Verification Script: Mobile Client Simulation (Native Node.js WebSocket)
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const session = "p2ExAWEyAWEzeGp0Y28yRndXQ0JoTU5l";
const relayUrl = `wss://tailsend-poc.mat2uken.workers.dev/relay?session=${encodeURIComponent(session)}&role=joiner`;

console.log(`[Mobile Sim] Connecting to Edge Relay: ${relayUrl}`);

const ws = new WebSocket(relayUrl);

ws.addEventListener("open", async () => {
    console.log("[Mobile Sim] Connected to Edge Relay!");

    // 1. Send Text Message
    console.log("[Mobile Sim] Sending test message...");
    ws.send(JSON.stringify({
        type: "text",
        channel: 101,
        text: "🍎 Hello from Mobile (iPhone Simulator) on macOS!",
        timestamp: Math.floor(Date.now() / 1000)
    }));

    await new Promise(r => setTimeout(r, 1000));

    // 2. Send 5MB Test File in 64 KiB Chunks
    const fileSize = 5 * 1024 * 1024; // 5 MB
    const testData = crypto.randomBytes(fileSize);
    const originalHash = crypto.createHash("sha256").update(testData).digest("hex");
    console.log(`[Mobile Sim] Generated 5MB test file. SHA-256: ${originalHash}`);

    const chunkSize = 64 * 1024;
    const totalChunks = Math.ceil(fileSize / chunkSize);
    const fileId = `file-${Date.now()}`;
    const filename = `test_transfer_macos_${Date.now()}.bin`;

    console.log(`[Mobile Sim] Sending file_start: ${filename} (${totalChunks} chunks)`);
    ws.send(JSON.stringify({
        type: "file_start",
        channel: 102,
        fileId: fileId,
        filename: filename,
        totalBytes: fileSize,
        totalChunks: totalChunks,
        timestamp: Math.floor(Date.now() / 1000)
    }));

    for (let i = 0; i < totalChunks; i++) {
        const chunk = testData.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, fileSize));
        const b64 = chunk.toString("base64");
        ws.send(JSON.stringify({
            type: "file_chunk",
            channel: 102,
            fileId: fileId,
            chunkIndex: i,
            data: b64
        }));
        if (i % 10 === 0) {
            await new Promise(r => setTimeout(r, 5));
        }
    }

    console.log("[Mobile Sim] Sending file_complete");
    ws.send(JSON.stringify({
        type: "file_complete",
        channel: 102,
        fileId: fileId
    }));

    await new Promise(r => setTimeout(r, 2000));

    // Check received file in Downloads/TailSend
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const receivedPath = path.join(homeDir, "Downloads", "TailSend", filename);
    console.log(`[Mobile Sim] Verifying saved file at: ${receivedPath}`);

    if (fs.existsSync(receivedPath)) {
        const receivedData = fs.readFileSync(receivedPath);
        const receivedHash = crypto.createHash("sha256").update(receivedData).digest("hex");
        console.log(`[Mobile Sim] Received file SHA-256: ${receivedHash}`);
        if (originalHash === receivedHash) {
            console.log("✅ SHA-256 100% MATCH! File transfer verified on macOS!");
        } else {
            console.error("❌ SHA-256 MISMATCH!");
        }
    } else {
        console.error("❌ Received file does not exist at expected path!");
    }

    ws.close();
});

ws.addEventListener("message", (event) => {
    console.log("[Mobile Sim Received]", event.data);
});

ws.addEventListener("error", (err) => {
    console.error("[Mobile Sim Error]", err);
});
