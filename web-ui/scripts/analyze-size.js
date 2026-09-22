import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const formatBytes = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(2)} KB`);
const row = (label, sizes) =>
  console.log(
    label.padEnd(38),
    ...sizes.map((value) => (typeof value === "number" ? formatBytes(value) : value).padStart(10)),
  );

// Measure the actual Vite output, including its worker and dynamic chunks.
// A second bundler configuration would measure different code from the product.
for (const [mode, label] of [
  ["web", "Web"],
  ["native", "Native"],
]) {
  const directory = resolve(root, `dist/${mode}/assets`);
  if (!existsSync(directory)) {
    console.error(
      `Missing ${directory}; run npm run build -- --mode ${mode === "native" ? "tauri" : "web"} first`,
    );
    process.exitCode = 1;
    continue;
  }
  console.log(`\nProduction Assets (dist/${mode}/assets)`);
  row("Asset", ["Raw", "Gzip", "Brotli"]);
  const total = [0, 0, 0];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(resolve(directory, entry.name));
    const sizes = [
      bytes.length,
      gzipSync(bytes, { level: 9 }).length,
      brotliCompressSync(bytes).length,
    ];
    sizes.forEach((size, index) => {
      total[index] += size;
    });
    row(entry.name, sizes);
  }
  row(`TOTAL (${label} Assets)`, total);
}
