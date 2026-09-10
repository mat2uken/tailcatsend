// Backward-compatible entry point for the current bidirectional WebView test.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const script = path.resolve(__dirname, "test_web_to_web_real.mjs");
const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
