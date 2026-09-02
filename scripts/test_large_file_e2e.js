// Large File Transfer E2E Test (Robust wait & verify)
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const session = "p2ExAWEyAWEzeGp0Y28yRndXQ0JoTU5l";
const relayUrl = `wss://tailsend-poc.mat2uken.workers.dev/relay?session=${encodeURIComponent(session)}&role=joiner`;

console.log(`[Large File Test] Connecting to Edge Relay...`);
const ws = new WebSocket(relayUrl);

ws.addEventListener("open", async () => {
    console.log("[Large File Test] Connected!");

    const fileSize = 100 * 1024 * 1024; // 100 MB
    console.log(`[Large File Test] Generating ${fileSize / (1024*1024)}MB random data in memory...`);
    const testData = crypto.randomBytes(fileSize);
    const originalHash = crypto.createHash("sha256").update(testData).digest("hex");
    console.log(`[Large File Test] Source SHA-256: ${originalHash}`);

    const chunkSize = 64 * 1024;
    const totalChunks = Math.ceil(fileSize / chunkSize);
    const fileId = `large-file-${Date.now()}`;
    const filename = `test_100mb_video_macos_${Date.now()}.mp4`;

    console.log(`[Large File Test] Starting stream transfer: ${filename} (${totalChunks} chunks)`);
    const startTime = Date.now();

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
        if (i % 30 === 0) {
            await new Promise(r => setTimeout(r, 1));
        }
    }

    ws.send(JSON.stringify({
        type: "file_complete",
        channel: 102,
        fileId: fileId
    }));

    const duration = (Date.now() - startTime) / 1000;
    const speed = (fileSize / (1024 * 1024)) / duration;
    console.log(`[Large File Test] Sent 100MB in ${duration.toFixed(2)}s (${speed.toFixed(2)} MB/s)`);

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const receivedPath = path.join(homeDir, "Downloads", "TailSend", filename);
    console.log(`[Large File Test] Waiting for desktop to finish writing to: ${receivedPath}`);

    // Poll until file size reaches expected fileSize
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(r => setTimeout(r, 500));
        if (fs.existsSync(receivedPath)) {
            const stats = fs.statSync(receivedPath);
            if (stats.size === fileSize) {
                ready = true;
                break;
            }
        }
    }

    if (ready) {
        const receivedData = fs.readFileSync(receivedPath);
        const receivedHash = crypto.createHash("sha256").update(receivedData).digest("hex");
        console.log(`[Large File Test] Received SHA-256: ${receivedHash}`);
        if (originalHash === receivedHash) {
            console.log("🎉 100MB Ultra-Large File SHA-256 100% MATCH! macOS Transfer Verified!");
        } else {
            console.error("❌ SHA-256 MISMATCH!");
        }
    } else {
        console.error("❌ File not found or incomplete size!");
    }

    ws.close();
});
