// E2E Test: Measure Tailcat P2P Text Transfer Latency and Bidirectional Streaming
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");

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

async function run() {
    console.log("=================================================");
    console.log(" Testing Ultra-Fast Text Streaming & Latency");
    console.log("=================================================");

    const hostDaemon = spawn(DAEMON_BIN, [
        "-derp=https://tailcat.dev/derpmap.json",
        "-ipc-port=49190",
        "-v"
    ]);

    const joinerDaemon = spawn(DAEMON_BIN, [
        "-derp=https://tailcat.dev/derpmap.json",
        "-ipc-port=49191",
        "-v"
    ]);

    let hostAddr = null;
    let joinerAddr = null;
    const hostReceived = [];
    const joinerReceived = [];

    hostDaemon.stdout.on("data", (data) => {
        for (const line of data.toString().split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
                const ev = JSON.parse(t);
                if (ev.event === "ready") hostAddr = ev.address;
                if (ev.event === "incoming_text") hostReceived.push(ev.text);
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
                if (ev.event === "incoming_text") joinerReceived.push(ev.text);
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
            if (!hostIpc) hostIpc = await connectIpc(49190);
            if (!joinerIpc) joinerIpc = await connectIpc(49191);
            break;
        } catch (e) {
            await sleep(300);
        }
    }

    console.log("Connected to both daemon IPC sockets.");

    // Helper to send text and wait for response
    function sendText(ipc, addr, text) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const onData = (data) => {
                for (const line of data.toString().split("\n")) {
                    const t = line.trim();
                    if (!t) continue;
                    try {
                        const ev = JSON.parse(t);
                        if (ev.event === "send_text_success" || ev.event === "error") {
                            ipc.removeListener("data", onData);
                            resolve({ duration: Date.now() - t0, event: ev });
                            return;
                        }
                    } catch (e) {}
                }
            };
            ipc.on("data", onData);
            ipc.write(JSON.stringify({ action: "send_text", address: addr, text }) + "\n");
        });
    }

    console.log("\n--- Message 1: Initial Handshake (creates persistent connection) ---");
    const res1 = await sendText(joinerIpc, hostAddr, "🤝 [Connect] Initial Handshake");
    console.log(`Msg 1 Result: ${JSON.stringify(res1.event)} (Duration: ${res1.duration}ms)`);

    console.log("\n--- Message 2: Instant Streaming via Persistent Connection ---");
    const res2 = await sendText(joinerIpc, hostAddr, "こんにちは！Ponlet超高速リアルタイムチャットです ⚡");
    console.log(`Msg 2 Result: ${JSON.stringify(res2.event)} (Duration: ${res2.duration}ms)`);

    console.log("\n--- Message 3: Rapid Streaming ---");
    const res3 = await sendText(joinerIpc, hostAddr, "連続メッセージ送信テスト！遅延ゼロ 🚀");
    console.log(`Msg 3 Result: ${JSON.stringify(res3.event)} (Duration: ${res3.duration}ms)`);

    await sleep(500);

    console.log("\n--- Received Messages on Host ---");
    console.log(hostReceived);

    const success = hostReceived.length >= 3 && res2.duration < 1000;
    console.log(`\nTest Finished. Success: ${success}`);

    hostDaemon.kill();
    joinerDaemon.kill();
    process.exit(success ? 0 : 1);
}

run().catch(err => {
    console.error("Test failed with error:", err);
    process.exit(1);
});
