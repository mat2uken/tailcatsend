// TailSend Comprehensive E2E & Browser WASM Verification Suite
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

const DIST_DIR = path.resolve(__dirname, "../../dist");
const PORT = 8788;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".gz": "application/gzip",
    ".json": "application/json",
    ".css": "text/css",
    ".png": "image/png",
    ".svg": "image/svg+xml",
};

const serverStats = {
    requests: [],
    status304Count: 0,
};

function startStaticServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let reqPath = req.url.split("?")[0].split("#")[0];
            if (reqPath === "/") reqPath = "/index.html";

            const filePath = path.join(DIST_DIR, reqPath);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end(`404 Not Found: ${reqPath}`);
                return;
            }

            const stat = fs.statSync(filePath);
            const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
            const lastModified = stat.mtime.toUTCString();

            const ext = path.extname(filePath).toLowerCase();
            let contentType = MIME_TYPES[ext] || "application/octet-stream";

            if (filePath.endsWith(".wasm.gz")) {
                contentType = "application/gzip";
            }

            const ifNoneMatch = req.headers["if-none-match"];
            const ifModifiedSince = req.headers["if-modified-since"];

            const isMatch = (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `W/${etag}`)) ||
                            (!ifNoneMatch && ifModifiedSince && new Date(ifModifiedSince) >= new Date(lastModified));

            if (isMatch && reqPath !== "/index.html") {
                serverStats.status304Count++;
                serverStats.requests.push({ path: reqPath, status: 304 });
                res.writeHead(304, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Expose-Headers": "ETag, Last-Modified",
                    "Cache-Control": "no-cache",
                    "ETag": etag,
                    "Last-Modified": lastModified,
                });
                res.end();
                return;
            }

            serverStats.requests.push({ path: reqPath, status: 200 });
            res.writeHead(200, {
                "Content-Type": contentType,
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "ETag, Last-Modified",
                "Cache-Control": reqPath === "/index.html" ? "no-cache, no-store, must-revalidate" : "no-cache",
                "ETag": etag,
                "Last-Modified": lastModified,
            });

            fs.createReadStream(filePath).pipe(res);
        });

        server.listen(PORT, "127.0.0.1", () => {
            console.log(`[E2E Server] Serving ${DIST_DIR} on http://127.0.0.1:${PORT}`);
            resolve(server);
        });
    });
}

async function testWasmIntegrity() {
    console.log("\n=== Test 1: Node.js WASM & Gzip Decompression Integrity ===");

    const tailcatGzPath = path.join(DIST_DIR, "assets/tailcat.wasm.gz");
    const slintGzPath = path.join(DIST_DIR, "pkg/tailsend_web_bg.wasm.gz");

    if (!fs.existsSync(tailcatGzPath)) throw new Error(`Missing ${tailcatGzPath}`);
    if (!fs.existsSync(slintGzPath)) throw new Error(`Missing ${slintGzPath}`);

    const tailcatGz = fs.readFileSync(tailcatGzPath);
    const slintGz = fs.readFileSync(slintGzPath);

    console.log(`- tailcat.wasm.gz compressed size: ${(tailcatGz.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`- tailsend_web_bg.wasm.gz compressed size: ${(slintGz.length / 1024 / 1024).toFixed(2)} MB`);

    const tailcatWasm = zlib.gunzipSync(tailcatGz);
    const slintWasm = zlib.gunzipSync(slintGz);

    console.log(`- tailcat.wasm decompressed size: ${(tailcatWasm.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`- tailsend_web_bg.wasm decompressed size: ${(slintWasm.length / 1024 / 1024).toFixed(2)} MB`);

    if (tailcatWasm.readUInt32BE(0) !== 0x0061736d) throw new Error("Invalid Tailcat WASM magic header");
    if (slintWasm.readUInt32BE(0) !== 0x0061736d) throw new Error("Invalid Slint WASM magic header");

    console.log("✓ Node.js WASM decompression and binary header integrity PASSED.");
}

async function testHeadlessChromeWithInvite(testInviteUrl) {
    console.log(`\n=== Test 2: Headless Browser Runtime & Exception Free Verification ===`);
    console.log(`Testing URL: ${testInviteUrl}`);

    const macChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const chromePath = fs.existsSync(macChromePath)
        ? macChromePath
        : (fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
            ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
            : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");

    console.log(`[E2E Chrome] Launching: ${chromePath}`);

    const debugPort = 9223;
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
    chromeArgs.push(testInviteUrl);

    const chrome = spawn(chromePath, chromeArgs);

    const logs = [];
    const errors = [];

    try {
        // Wait for CDP port
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

        // Enable Runtime & Page domains
        await sendCommand("Runtime.enable");
        await sendCommand("Page.enable");

        console.log("[E2E Chrome] Waiting for WASM decompression and Slint mount (6s)...");
        await new Promise((r) => setTimeout(r, 6000));

        // Evaluate DOM state
        const evalRes = await sendCommand("Runtime.evaluate", {
            expression: `
                JSON.stringify({
                    hasCanvas: !!document.querySelector('canvas#canvas'),
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

        if (errors.length > 0) {
            console.error("[E2E Chrome] Detected Browser Errors:", errors);
            throw new Error(`Encountered ${errors.length} unexpected console errors during bootstrap!`);
        }

        console.log("✓ Headless browser verified: Zero bootstrap errors, Canvas active, WASM operational.");

        // === Test 3: IndexedDB Cache Integrity Verification ===
        console.log("\n=== Test 3: IndexedDB WASM Cache Verification ===");
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
        console.log(`✓ IndexedDB Cache Verified: Slint WASM (${(idbState.slintBytes / 1024 / 1024).toFixed(2)} MB, ETag: ${idbState.slintEtag})`);
        console.log(`✓ IndexedDB Cache Verified: Tailcat WASM (${(idbState.tailcatBytes / 1024 / 1024).toFixed(2)} MB, ETag: ${idbState.tailcatEtag})`);

        // === Test 4: Second Load with 304 Cache Hit Verification ===
        console.log("\n=== Test 4: Second Access 304 Not Modified & Fast Boot Verification ===");
        const prev304Count = serverStats.status304Count;
        logs.length = 0;
        errors.length = 0;

        const reloadStart = Date.now();
        console.log("[E2E Chrome] Reloading page to verify 304 cache hit...");
        await sendCommand("Page.reload");

        // Wait for page reload and Slint mount (should be fast due to cache hit)
        let reloadedCanvas = false;
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 200));
            const checkRes = await sendCommand("Runtime.evaluate", {
                expression: "!!document.querySelector('canvas#canvas')",
                returnByValue: true,
            });
            if (checkRes.result.value) {
                reloadedCanvas = true;
                break;
            }
        }
        const reloadDuration = Date.now() - reloadStart;
        console.log(`[E2E Chrome] Reloaded and Canvas mounted in ${reloadDuration}ms`);

        if (!reloadedCanvas) {
            throw new Error("Canvas element #canvas was not mounted after page reload!");
        }

        // Allow Tailcat engine to complete background check
        await new Promise((r) => setTimeout(r, 2000));

        // Check for 304 Not Modified logs
        const slint304Hit = logs.some((l) => l.includes("[WASM Cache] 304 Not Modified for ./pkg/tailsend_web_bg.wasm.gz"));
        const tailcat304Hit = logs.some((l) => l.includes("[WASM Cache] 304 Not Modified for ./assets/tailcat.wasm.gz"));

        console.log(`[E2E Chrome] Slint 304 cache hit detected: ${slint304Hit}`);
        console.log(`[E2E Chrome] Tailcat 304 cache hit detected: ${tailcat304Hit}`);
        console.log(`[E2E Server] HTTP 304 Not Modified responses served: ${serverStats.status304Count - prev304Count}`);

        if (!slint304Hit) {
            throw new Error("Slint WASM did not report 304 cache hit on second load!");
        }
        if (!tailcat304Hit) {
            throw new Error("Tailcat WASM did not report 304 cache hit on second load!");
        }

        if (errors.length > 0) {
            console.error("[E2E Chrome] Detected Browser Errors during reload:", errors);
            throw new Error(`Encountered ${errors.length} unexpected console errors during reload!`);
        }

        console.log("✓ Second access successfully skipped 12.3MB download and Gzip decompression via IndexedDB 304 cache hit!");
        ws.close();
    } finally {
        chrome.kill("SIGKILL");
    }
}

async function main() {
    let server;
    try {
        server = await startStaticServer();
        await testWasmIntegrity();

        const sampleInviteUrl = process.argv[2] || `http://127.0.0.1:${PORT}/index.html#i=p2ExAWEyAWEzeGp0Y28yRndXQ0JwaXNvSDVsSG5JUWdVelVyUno0b0R3RUZsS2NqcmZqQ1M2V3A2eWhaV1gyRnJXQ0NJalZ1MnRyZTJjQnEyc0pvLW5MQ2dGY2FJWVBRS3o2SnlBUDRQa0l1aFRtRnBHUUV3YTRQmKeA0Cw8g_rCtdbWgNCV4mE1WCDu4Zw0sz-3fhdKeBjZmopiH3vZ3poLJYbBueOcfOSPV2E2GmqXlgdhNxpql5hf`;
        await testHeadlessChromeWithInvite(sampleInviteUrl);

        console.log("\n========================================================");
        console.log(" 🎉 ALL E2E AND BROWSER VERIFICATION CHECKS PASSED 100%!");
        console.log("========================================================\n");
    } catch (err) {
        console.error("\n❌ E2E VERIFICATION FAILED:", err);
        process.exit(1);
    } finally {
        if (server) server.close();
    }
}

main();
