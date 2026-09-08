// E2E Test: Bidirectional Real WireGuard P2P File Transfer with SHA-256 Verification
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const DAEMON_BIN = path.resolve(__dirname, "../../tailcat_daemon");

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function connectIpc(port) {
    return new Promise((resolve, reject) => {
        const s = net.connect({ host: "127.0.0.1", port }, () => {
            resolve(s);
        });
        s.on("error", reject);
    });
}

function computeSha256(filePath) {
    const data = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(data).digest("hex");
}

async function run() {
    console.log("=================================================================");
    console.log(" Testing Bidirectional Real WireGuard P2P File Transfer & SHA-256");
    console.log("=================================================================");

    const hostDaemon = spawn(DAEMON_BIN, [
        "-derp=https://tailcat.dev/derpmap.json",
        "-ipc-port=49200",
        "-v"
    ]);

    const joinerDaemon = spawn(DAEMON_BIN, [
        "-derp=https://tailcat.dev/derpmap.json",
        "-ipc-port=49201",
        "-v"
    ]);

    let hostAddr = null;
    let joinerAddr = null;
    const hostReceivedFiles = [];
    const joinerReceivedFiles = [];

    hostDaemon.stdout.on("data", (data) => {
        for (const line of data.toString().split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
                const ev = JSON.parse(t);
                if (ev.event === "ready") hostAddr = ev.address;
                if (ev.event === "incoming_file") hostReceivedFiles.push(ev);
            } catch (e) {}
        }
    });

    joinerDaemon.stdout.on("data", (data) => {
        for (const line of data.toString().split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
                const ev = JSON.parse(t);
                if (ev.event === "ready") joinerAddr = ev.address;
                if (ev.event === "incoming_file") joinerReceivedFiles.push(ev);
            } catch (e) {}
        }
    });

    console.log("Waiting for both daemons to initialize...");
    for (let i = 0; i < 30; i++) {
        if (hostAddr && joinerAddr) break;
        await sleep(500);
    }

    if (!hostAddr || !joinerAddr) {
        console.error("Failed to get addresses. Host:", hostAddr, "Joiner:", joinerAddr);
        hostDaemon.kill();
        joinerDaemon.kill();
        process.exit(1);
    }

    console.log("Host Address:  ", hostAddr);
    console.log("Joiner Address:", joinerAddr);

    let hostIpc = null;
    let joinerIpc = null;
    for (let i = 0; i < 10; i++) {
        try {
            if (!hostIpc) hostIpc = await connectIpc(49200);
            if (!joinerIpc) joinerIpc = await connectIpc(49201);
            break;
        } catch (e) {
            await sleep(300);
        }
    }

    console.log("Connected to both daemon IPC sockets.");

    // Helper to send file and wait for send confirmation
    function sendFile(ipc, addr, filePath, filename) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const onData = (data) => {
                for (const line of data.toString().split("\n")) {
                    const t = line.trim();
                    if (!t) continue;
                    try {
                        const ev = JSON.parse(t);
                        if (ev.event === "send_file_success" || ev.event === "error") {
                            ipc.removeListener("data", onData);
                            resolve({ duration: Date.now() - t0, event: ev });
                            return;
                        }
                    } catch (e) {}
                }
            };
            ipc.on("data", onData);
            ipc.write(JSON.stringify({
                action: "send_file",
                address: addr,
                path: filePath,
                filename: filename
            }) + "\n");
        });
    }

    const testDir = path.resolve(__dirname, "../../scratch");
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    // -------------------------------------------------------------
    // Test 1: Joiner -> Host (512 KiB random payload)
    // -------------------------------------------------------------
    console.log("\n--- Direction 1: Joiner -> Host File Transfer (512 KiB) ---");
    const file1Name = `joiner_to_host_${Date.now()}.bin`;
    const file1Path = path.join(testDir, file1Name);
    const file1Data = crypto.randomBytes(512 * 1024);
    fs.writeFileSync(file1Path, file1Data);
    const file1ExpectedSha = crypto.createHash("sha256").update(file1Data).digest("hex");
    console.log(`Payload: ${file1Name} (${file1Data.length} bytes)`);
    console.log(`Expected SHA-256: ${file1ExpectedSha}`);

    const res1 = await sendFile(joinerIpc, hostAddr, file1Path, file1Name);
    console.log(`Send Result: ${JSON.stringify(res1.event)} (Duration: ${res1.duration}ms)`);

    // Wait for incoming_file event on Host
    console.log("Waiting for file reception on Host...");
    for (let i = 0; i < 30; i++) {
        if (hostReceivedFiles.some(f => f.filename === file1Name)) break;
        await sleep(300);
    }

    const hostRecv = hostReceivedFiles.find(f => f.filename === file1Name);
    if (!hostRecv) {
        throw new Error(`Host did not receive ${file1Name}`);
    }
    console.log(`Host received file at: ${hostRecv.path} (${hostRecv.size} bytes)`);

    const file1ActualSha = computeSha256(hostRecv.path);
    console.log(`Actual SHA-256:   ${file1ActualSha}`);
    const match1 = (file1ActualSha === file1ExpectedSha);
    console.log(`SHA-256 Match: ${match1 ? "✅ MATCH" : "❌ MISMATCH"}`);

    if (!match1) throw new Error("SHA-256 mismatch on Direction 1");

    // -------------------------------------------------------------
    // Test 2: Host -> Joiner (1024 KiB = 1 MiB random payload)
    // -------------------------------------------------------------
    console.log("\n--- Direction 2: Host -> Joiner File Transfer (1 MiB) ---");
    const file2Name = `host_to_joiner_${Date.now()}.bin`;
    const file2Path = path.join(testDir, file2Name);
    const file2Data = crypto.randomBytes(1024 * 1024);
    fs.writeFileSync(file2Path, file2Data);
    const file2ExpectedSha = crypto.createHash("sha256").update(file2Data).digest("hex");
    console.log(`Payload: ${file2Name} (${file2Data.length} bytes)`);
    console.log(`Expected SHA-256: ${file2ExpectedSha}`);

    const res2 = await sendFile(hostIpc, joinerAddr, file2Path, file2Name);
    console.log(`Send Result: ${JSON.stringify(res2.event)} (Duration: ${res2.duration}ms)`);

    // Wait for incoming_file event on Joiner
    console.log("Waiting for file reception on Joiner...");
    for (let i = 0; i < 30; i++) {
        if (joinerReceivedFiles.some(f => f.filename === file2Name)) break;
        await sleep(300);
    }

    const joinerRecv = joinerReceivedFiles.find(f => f.filename === file2Name);
    if (!joinerRecv) {
        throw new Error(`Joiner did not receive ${file2Name}`);
    }
    console.log(`Joiner received file at: ${joinerRecv.path} (${joinerRecv.size} bytes)`);

    const file2ActualSha = computeSha256(joinerRecv.path);
    console.log(`Actual SHA-256:   ${file2ActualSha}`);
    const match2 = (file2ActualSha === file2ExpectedSha);
    console.log(`SHA-256 Match: ${match2 ? "✅ MATCH" : "❌ MISMATCH"}`);

    if (!match2) throw new Error("SHA-256 mismatch on Direction 2");

    console.log("\n=================================================================");
    console.log(" 🎉 ALL BIDIRECTIONAL P2P FILE TRANSFER TESTS PASSED 100%!");
    console.log(" - Direction 1 (Joiner -> Host, 512 KiB): SHA-256 Verified");
    console.log(" - Direction 2 (Host -> Joiner, 1 MiB):   SHA-256 Verified");
    console.log("=================================================================\n");

    // Clean up temporary files
    try {
        fs.unlinkSync(file1Path);
        fs.unlinkSync(file2Path);
        if (fs.existsSync(hostRecv.path)) fs.unlinkSync(hostRecv.path);
        if (fs.existsSync(joinerRecv.path)) fs.unlinkSync(joinerRecv.path);
    } catch (_) {}

    hostDaemon.kill();
    joinerDaemon.kill();
    process.exit(0);
}

run().catch(err => {
    console.error("\n❌ BIDIRECTIONAL FILE TRANSFER TEST FAILED:", err);
    process.exit(1);
});
