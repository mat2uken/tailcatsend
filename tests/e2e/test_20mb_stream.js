// Automated 20MB Streaming Test (320 chunks of 64KB) with SHA-256 Checksum Verification
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

async function test20MBStream() {
    console.log("\n=========================================================================");
    console.log("  [E2E Stress Test] 20 MB High-Throughput Chunked Streaming & Checksum   ");
    console.log("=========================================================================");

    const logPath = "C:\\Users\\ku\\.gemini\\antigravity-cli\\brain\\52fbc68e-d96e-4bcc-ac94-ffac5444e3c7\\.system_generated\\tasks\\task-1611.log";
    const logContent = fs.readFileSync(logPath, "utf-8");
    const match = logContent.match(/Generated Cloudflare QR Invitation URL: (https:\/\/[^\s]+)/);
    if (!match) throw new Error("Could not find invitation URL");

    const liveUrl = match[1];
    const sessionTokenMatch = liveUrl.match(/i=([^&]+)/);
    const sessionId = sessionTokenMatch[1].slice(0, 32);
    const relayWsUrl = `wss://tailsend-poc.mat2uken.workers.dev/relay?session=${encodeURIComponent(sessionId)}&role=client`;

    console.log(`[20MB Test] Direct Stream Sender to Relay: ${relayWsUrl}`);

    const CHUNK_SIZE = 64 * 1024; // 64 KiB
    const totalBytes = 20 * 1024 * 1024; // 20,971,520 bytes
    const totalChunks = totalBytes / CHUNK_SIZE; // 320 chunks

    console.log(`[20MB Test] Generating 20MB random payload (320 chunks)...`);
    const testData = crypto.randomBytes(totalBytes);
    const expectedSha256 = crypto.createHash("sha256").update(testData).digest("hex");
    const filename = "iphone_20mb_pro_video.mov";

    console.log(`[20MB Test] Expected SHA-256: ${expectedSha256}`);

    const ws = new WebSocket(relayWsUrl);
    await new Promise((r) => ws.onopen = r);

    const fileId = "file-20mb-" + Date.now();
    const startTime = performance.now();

    // 1. Send file_start
    ws.send(JSON.stringify({
        type: "file_start",
        channel: 102,
        fileId: fileId,
        filename: filename,
        totalBytes: totalBytes,
        totalChunks: totalChunks,
        timestamp: Date.now()
    }));

    // 2. Send 320 chunks with backpressure
    for (let i = 0; i < totalChunks; i++) {
        while (ws.bufferedAmount > 256 * 1024) {
            await new Promise(r => setTimeout(r, 5));
        }

        const chunkSlice = testData.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        ws.send(JSON.stringify({
            type: "file_chunk",
            channel: 102,
            fileId: fileId,
            chunkIndex: i,
            data: chunkSlice.toString("base64")
        }));

        if (i % 50 === 0) {
            const elapsed = (performance.now() - startTime) / 1000;
            const transferredMB = ((i + 1) * CHUNK_SIZE / 1048576).toFixed(1);
            const speed = elapsed > 0 ? (transferredMB / elapsed).toFixed(1) + " MB/s" : "";
            console.log(`[20MB Test] Progress: ${Math.round(((i + 1) / totalChunks) * 100)}% (${transferredMB} MB / 20.0 MB) • ${speed}`);
        }
    }

    // 3. Send file_complete
    ws.send(JSON.stringify({
        type: "file_complete",
        channel: 102,
        fileId: fileId
    }));

    const totalElapsed = (performance.now() - startTime) / 1000;
    console.log(`[20MB Test] Finished streaming in ${totalElapsed.toFixed(2)}s (${(20.0 / totalElapsed).toFixed(1)} MB/s)`);
    console.log("[20MB Test] Waiting 3s for PC disk write...");
    await new Promise((r) => setTimeout(r, 3000));

    // Validate on PC disk
    const downloadDir = path.join(os.homedir(), "Downloads", "TailSend");
    const savedFilePath = path.join(downloadDir, filename);

    if (!fs.existsSync(savedFilePath)) throw new Error(`File not found at: ${savedFilePath}`);
    const savedBytes = fs.readFileSync(savedFilePath);
    const actualSha256 = crypto.createHash("sha256").update(savedBytes).digest("hex");

    console.log(`[20MB Test] Saved size: ${savedBytes.length} bytes (Expected: ${totalBytes})`);
    console.log(`[20MB Test] Actual SHA-256:   ${actualSha256}`);

    if (actualSha256 === expectedSha256 && savedBytes.length === totalBytes) {
        console.log("✅ SUCCESS: 20MB high-throughput chunked stream verified with 100% SHA-256 integrity!");
    } else {
        throw new Error("SHA-256 checksum mismatch!");
    }

    ws.close();
}

test20MBStream().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
