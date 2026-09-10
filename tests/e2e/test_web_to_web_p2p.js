// Backward-compatible entry point for the current WebView transfer test.
// The old CDP script used globals that no longer exist in the shared VanJS UI.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const script = path.resolve(__dirname, "test_web_to_web_real.mjs");
const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
