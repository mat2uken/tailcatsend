const sessionId = process.argv[2] || process.env.TAILSEND_SESSION;
if (!sessionId) {
    console.error("Usage: node scripts/test_ios_e2e.js <SESSION_ID_OR_TOKEN>");
    process.exit(1);
}
const relayUrl = `wss://tailsend-poc.mat2uken.workers.dev/relay?session=${encodeURIComponent(sessionId)}&role=client`;

console.log(`[E2E Test] Connecting to iOS App via Edge Relay: ${relayUrl}`);
const ws = new WebSocket(relayUrl);

ws.onopen = async () => {
    console.log('[E2E Test] Connected to Relay Room!');

    // 1. Send Text Message
    console.log('[E2E Test] Sending text to iOS: "Hello iOS Native from macOS!"');
    ws.send(JSON.stringify({
        type: 'text',
        channel: 101,
        text: 'Hello iOS Native from macOS! Slint + Tokio is working smoothly 🚀',
        timestamp: Date.now()
    }));

    await new Promise(r => setTimeout(r, 1000));

    // 2. Stream a 5MB File in 64 KiB chunks
    const testFileSize = 5 * 1024 * 1024;
    const testData = Buffer.alloc(testFileSize, 0x5a); // 5MB buffer
    const filename = "ios_test_sample.mp4";
    const fileId = "file-ios-" + Date.now();
    const chunkSize = 64 * 1024;
    const totalChunks = Math.ceil(testData.length / chunkSize);

    console.log(`[E2E Test] Sending file "${filename}" (5.0 MB, ${totalChunks} chunks) to iOS...`);
    ws.send(JSON.stringify({
        type: 'file_start',
        channel: 102,
        fileId: fileId,
        filename: filename,
        totalBytes: testFileSize,
        totalChunks: totalChunks
    }));

    for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, testData.length);
        const chunk = testData.slice(start, end);

        ws.send(JSON.stringify({
            type: 'file_chunk',
            channel: 102,
            fileId: fileId,
            chunkIndex: i,
            data: chunk.toString('base64')
        }));

        if (i % 20 === 0 || i === totalChunks - 1) {
            console.log(`[E2E Test] Progress: ${Math.round(((i + 1) / totalChunks) * 100)}%`);
        }
        await new Promise(r => setTimeout(r, 15));
    }

    ws.send(JSON.stringify({
        type: 'file_complete',
        channel: 102,
        fileId: fileId
    }));

    console.log('[E2E Test] File transfer completed!');
    setTimeout(() => {
        ws.close();
        process.exit(0);
    }, 1500);
};

ws.onerror = (err) => {
    console.error('[E2E Test] WS Error:', err);
    process.exit(1);
};
