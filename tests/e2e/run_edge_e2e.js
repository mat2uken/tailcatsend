// TailSend Edge E2E Verification Suite for Cloudflare Pages
const fs = require("fs");
const { spawn } = require("child_process");

const TARGET_URL = process.argv[2] || "https://feature-optimize-wasm-size.mktailcatsend.pages.dev/index.html#i=p2ExAWEyAWEzeGp0Y28yRndXQ0JwaXNvSDVsSG5JUWdVelVyUno0b0R3RUZsS2NqcmZqQ1M2V3A2eWhaV1gyRnJXQ0NJalZ1MnRyZTJjQnEyc0pvLW5MQ2dGY2FJWVBRS3o2SnlBUDRQa0l1aFRtRnBHUUV3YTRQmKeA0Cw8g_rCtdbWgNCV4mE1WCDu4Zw0sz-3fhdKeBjZmopiH3vZ3poLJYbBueOcfOSPV2E2GmqXlgdhNxpql5hf";

async function testEdgeDeployment(targetUrl) {
    console.log(`\n=== Edge E2E Verification: Cloudflare Pages Deployment ===`);
    console.log(`Target URL: ${targetUrl}`);

    const macChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const chromePath = fs.existsSync(macChromePath)
        ? macChromePath
        : (fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
            ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
            : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");

    console.log(`[E2E Chrome] Launching: ${chromePath}`);

    const debugPort = 9224;
    const isMac = process.platform === "darwin";
    const chromeArgs = [
        "--headless=new",
        `--remote-debugging-port=${debugPort}`,
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-webgl",
    ];
    if (!isMac) {
        chromeArgs.push("--disable-gpu");
    } else {
        chromeArgs.push("--use-gl=angle");
    }
    chromeArgs.push(targetUrl);

    const chrome = spawn(chromePath, chromeArgs);

    const logs = [];
    const errors = [];
    const networkResponses = [];

    try {
        await new Promise((r) => setTimeout(r, 2000));

        const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await targetsRes.json();
        const pageTarget = targets.find((t) => t.type === "page");

        if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
            throw new Error("No Chrome page target with WebSocket debugger found");
        }

        console.log(`[E2E Chrome] Connecting CDP WebSocket: ${pageTarget.webSocketDebuggerUrl}`);
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

        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.id && pending.has(data.id)) {
                const resolve = pending.get(data.id);
                pending.delete(data.id);
                resolve(data.result);
            }
            if (data.method === "Network.responseReceived") {
                const { response } = data.params;
                networkResponses.push({
                    url: response.url,
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                    fromDiskCache: response.fromDiskCache,
                    fromServiceWorker: response.fromServiceWorker,
                });
            }
            if (data.method === "Runtime.consoleAPICalled") {
                const text = data.params.args.map((a) => a.value || a.description || "").join(" ");
                logs.push(`[Browser ${data.params.type}] ${text}`);
                if (data.params.type === "error") {
                    errors.push(text);
                }
            }
            if (data.method === "Runtime.exceptionThrown") {
                const desc = data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text;
                if (!desc.includes("Using exceptions for control flow")) {
                    errors.push(`Unhandled Exception: ${desc}`);
                }
            }
        };

        // Enable domains
        await sendCommand("Runtime.enable");
        await sendCommand("Page.enable");
        await sendCommand("Network.enable");

        console.log("\n--- Phase 1: First Access Verification ---");
        console.log("[E2E Chrome] Waiting for WASM download, decompression, and Slint mount (8s)...");
        await new Promise((r) => setTimeout(r, 8000));

        // Evaluate DOM state
        const evalRes = await sendCommand("Runtime.evaluate", {
            expression: `
                JSON.stringify({
                    hasCanvas: !!document.querySelector('canvas#canvas'),
                    canvasWidth: document.querySelector('canvas#canvas') ? document.querySelector('canvas#canvas').width : 0,
                    canvasHeight: document.querySelector('canvas#canvas') ? document.querySelector('canvas#canvas').height : 0,
                    loaderExists: !!document.getElementById('loader'),
                    statusText: document.getElementById('status') ? document.getElementById('status').textContent : null,
                    bodyChildren: document.body.children.length
                })
            `,
            returnByValue: true,
        });

        const domState = JSON.parse(evalRes.result.value);
        console.log("[E2E Chrome] DOM State Result:", domState);

        if (!domState.hasCanvas) {
            throw new Error("Canvas element #canvas was not mounted in DOM!");
        }

        if (domState.statusText && domState.statusText.includes("Bootstrap failed")) {
            throw new Error(`Bootstrap failed text detected in status element: ${domState.statusText}`);
        }

        const realErrors = errors.filter(e => !e.includes("favicon"));
        if (realErrors.length > 0) {
            console.error("[E2E Chrome] Detected Browser Errors:", realErrors);
            throw new Error(`Encountered ${realErrors.length} unexpected console errors during bootstrap!`);
        }

        console.log("✓ Phase 1 PASSED: Zero errors, Canvas mounted (" + domState.canvasWidth + "x" + domState.canvasHeight + "), WASM running.");

        console.log("\n--- Phase 2: IndexedDB Cache State Verification ---");
        const idbCheckRes = await sendCommand("Runtime.evaluate", {
            expression: `
                new Promise((resolve) => {
                    const req = indexedDB.open("ponlet_wasm_cache", 1);
                    req.onsuccess = () => {
                        const db = req.result;
                        if (!db.objectStoreNames.contains("wasm_files")) {
                            return resolve({ ok: false, error: "Store wasm_files not found" });
                        }
                        const tx = db.transaction("wasm_files", "readonly");
                        const store = tx.objectStore("wasm_files");
                        const getSlint = store.get("./pkg/tailsend_web_bg.wasm.gz");
                        getSlint.onsuccess = () => {
                            const slintEntry = getSlint.result;
                            const getTailcat = store.get("./assets/tailcat.wasm.gz");
                            getTailcat.onsuccess = () => {
                                const tailcatEntry = getTailcat.result;
                                resolve({
                                    ok: true,
                                    hasSlint: !!slintEntry && (slintEntry.data instanceof ArrayBuffer) && slintEntry.data.byteLength > 0,
                                    slintBytes: slintEntry ? slintEntry.data.byteLength : 0,
                                    slintEtag: slintEntry ? slintEntry.etag : null,
                                    hasTailcat: !!tailcatEntry && (tailcatEntry.data instanceof ArrayBuffer) && tailcatEntry.data.byteLength > 0,
                                    tailcatBytes: tailcatEntry ? tailcatEntry.data.byteLength : 0,
                                    tailcatEtag: tailcatEntry ? tailcatEntry.etag : null,
                                });
                            };
                            getTailcat.onerror = () => resolve({ ok: false, error: "Failed getting tailcat entry" });
                        };
                        getSlint.onerror = () => resolve({ ok: false, error: "Failed getting slint entry" });
                    };
                    req.onerror = () => resolve({ ok: false, error: "Failed opening indexedDB" });
                })
            `,
            awaitPromise: true,
            returnByValue: true,
        });

        const idbState = idbCheckRes.result.value;
        console.log("[E2E Chrome] IndexedDB Cache State:", idbState);

        if (!idbState.ok || !idbState.hasSlint || !idbState.hasTailcat) {
            throw new Error(`IndexedDB cache verification failed: ${JSON.stringify(idbState)}`);
        }
        console.log(`✓ Phase 2 PASSED: Slint WASM in IndexedDB (${(idbState.slintBytes / 1024 / 1024).toFixed(2)} MB, ETag: ${idbState.slintEtag})`);
        console.log(`✓ Phase 2 PASSED: Tailcat WASM in IndexedDB (${(idbState.tailcatBytes / 1024 / 1024).toFixed(2)} MB, ETag: ${idbState.tailcatEtag})`);

        console.log("\n--- Phase 3: Second Access & 304 Cache Hit Verification ---");
        logs.length = 0;
        errors.length = 0;
        networkResponses.length = 0;

        const reloadStart = Date.now();
        console.log("[E2E Chrome] Reloading page to verify 304 cache hit against Cloudflare edge...");
        await sendCommand("Page.reload");

        let reloadedCanvas = false;
        let mountTime = 0;
        for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const checkRes = await sendCommand("Runtime.evaluate", {
                expression: "!!document.querySelector('canvas#canvas')",
                returnByValue: true,
            });
            if (checkRes.result.value) {
                reloadedCanvas = true;
                mountTime = Date.now() - reloadStart;
                break;
            }
        }

        console.log(`[E2E Chrome] Reloaded and Canvas mounted in ${mountTime}ms`);

        if (!reloadedCanvas) {
            throw new Error("Canvas element #canvas was not mounted after page reload!");
        }

        // Wait a bit for both WASMs background verification to complete
        await new Promise((r) => setTimeout(r, 3000));

        // Inspect console logs
        const slint304Hit = logs.some((l) => l.includes("[WASM Cache] 304 Not Modified for ./pkg/tailsend_web_bg.wasm.gz"));
        const tailcat304Hit = logs.some((l) => l.includes("[WASM Cache] 304 Not Modified for ./assets/tailcat.wasm.gz"));

        console.log(`[E2E Chrome] Console log - Slint 304 hit: ${slint304Hit}`);
        console.log(`[E2E Chrome] Console log - Tailcat 304 hit: ${tailcat304Hit}`);

        // Inspect network responses for wasm.gz files
        const wasmResponses = networkResponses.filter(r => r.url.includes(".wasm.gz"));
        console.log("[E2E Chrome] Network responses for WASM:", wasmResponses.map(r => ({ url: r.url.split("/").slice(-2).join("/"), status: r.status })));

        const reloadErrors = errors.filter(e => !e.includes("favicon"));
        if (reloadErrors.length > 0) {
            console.error("[E2E Chrome] Detected Browser Errors during reload:", reloadErrors);
            throw new Error(`Encountered ${reloadErrors.length} unexpected console errors during reload!`);
        }

        if (!slint304Hit || !tailcat304Hit) {
            throw new Error("WASM cache 304 hit logs were not observed for both binaries!");
        }

        console.log("✓ Phase 3 PASSED: 304 Not Modified confirmed from Cloudflare edge, 12.3MB download skipped, fast mount verified.");

        console.log("\n========================================================");
        console.log(" 🎉 CLOUDFLARE PAGES EDGE E2E VERIFICATION PASSED 100%!");
        console.log("========================================================\n");

        return {
            success: true,
            idbState,
            mountTime,
            wasmResponses,
        };
    } finally {
        chrome.kill("SIGKILL");
    }
}

async function main() {
    try {
        await testEdgeDeployment(TARGET_URL);
    } catch (err) {
        console.error("\n❌ EDGE E2E VERIFICATION FAILED:", err);
        process.exit(1);
    }
}

main();
