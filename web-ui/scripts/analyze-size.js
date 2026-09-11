import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import esbuild from "esbuild";

const rootDir = path.resolve(import.meta.dirname, "..");

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function calcSizes(bufferOrString) {
  const buf = Buffer.isBuffer(bufferOrString) ? bufferOrString : Buffer.from(bufferOrString);
  const rawSize = buf.length;
  const gzipSize = zlib.gzipSync(buf, { level: 9 }).length;
  const brotliSize = zlib.brotliCompressSync(buf).length;
  return { rawSize, gzipSize, brotliSize };
}

function printRow(name, raw, gzip, brotli) {
  const col1 = name.padEnd(38);
  const col2 = (typeof raw === "number" ? formatBytes(raw) : raw).padStart(10);
  const col3 = (typeof gzip === "number" ? formatBytes(gzip) : gzip).padStart(10);
  const col4 = (typeof brotli === "number" ? formatBytes(brotli) : brotli).padStart(10);
  console.log(`${col1} ${col2} ${col3} ${col4}`);
}

function printHeader(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(71));
  printRow("Module / Target", "Raw", "Gzip", "Brotli");
  console.log("-".repeat(71));
}

async function bundleAndMeasureModule(entryPath, alias = {}) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2020",
    write: false,
    logLevel: "silent",
    alias,
  });
  return calcSizes(result.outputFiles[0].contents);
}

async function bundleApplication(backendPath) {
  const result = await esbuild.build({
    entryPoints: [path.resolve(rootDir, "src/main.ts")],
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2020",
    write: false,
    outdir: "virtual-dist",
    logLevel: "silent",
    alias: {
      "@backend": backendPath,
    },
  });

  const files = result.outputFiles.map((file) => {
    const filename = path.basename(file.path);
    const sizes = calcSizes(file.contents);
    return { filename, ...sizes };
  });

  let totalRaw = 0;
  let totalGzip = 0;
  let totalBrotli = 0;
  for (const f of files) {
    totalRaw += f.rawSize;
    totalGzip += f.gzipSize;
    totalBrotli += f.brotliSize;
  }

  return {
    files,
    total: { rawSize: totalRaw, gzipSize: totalGzip, brotliSize: totalBrotli },
  };
}

function measureDistAssets(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return null;
  }
  const entries = fs.readdirSync(dirPath);
  const files = [];
  let totalRaw = 0;
  let totalGzip = 0;
  let totalBrotli = 0;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      continue;
    }

    const content = fs.readFileSync(fullPath);
    const sizes = calcSizes(content);
    files.push({ name: entry, ...sizes });
    totalRaw += sizes.rawSize;
    totalGzip += sizes.gzipSize;
    totalBrotli += sizes.brotliSize;
  }

  return {
    files,
    total: { rawSize: totalRaw, gzipSize: totalGzip, brotliSize: totalBrotli },
  };
}

async function main() {
  console.log("=".repeat(71));
  console.log("         tailcatsend / web-ui - Bundle Size Analysis");
  console.log("=".repeat(71));

  // 1. Core Modules
  printHeader("[1] Core & Individual Modules (esbuild minified)");
  const coreModules = [
    { file: "node_modules/vanjs-core/src/van.js", label: "vanjs-core" },
    { file: "src/lib/position.ts", label: "src/lib/position.ts" },
    { file: "src/lib/toast.ts", label: "src/lib/toast.ts" },
    { file: "src/session.ts", label: "src/session.ts" },
    { file: "src/update/client.ts", label: "src/update/client.ts" },
    { file: "src/worker.ts", label: "src/worker.ts" },
  ];

  for (const mod of coreModules) {
    const fullPath = path.resolve(rootDir, mod.file);
    if (fs.existsSync(fullPath)) {
      try {
        const sizes = await bundleAndMeasureModule(fullPath);
        printRow(mod.label, sizes.rawSize, sizes.gzipSize, sizes.brotliSize);
      } catch {
        printRow(mod.label, "(build error)", "-", "-");
      }
    } else {
      printRow(mod.label, "(not found)", "-", "-");
    }
  }
  console.log("-".repeat(71));

  // 2. Stylesheet
  printHeader("[2] Stylesheet");
  const cssPath = path.resolve(rootDir, "src/style.css");
  if (fs.existsSync(cssPath)) {
    const rawCss = fs.readFileSync(cssPath, "utf8");
    const minCss = (await esbuild.transform(rawCss, { loader: "css", minify: true })).code;
    const cssSizes = calcSizes(minCss);
    printRow("src/style.css (minified)", cssSizes.rawSize, cssSizes.gzipSize, cssSizes.brotliSize);
  } else {
    printRow("src/style.css", "(not found)", "-", "-");
  }
  console.log("-".repeat(71));

  // 3. Core Runtime Bundles (src/main.ts + backends)
  printHeader("[3] Core Runtime Bundles (src/main.ts + Backends)");
  const backends = [
    {
      name: "Web Runtime (Browser Backend)",
      path: path.resolve(rootDir, "src/backends/browser.ts"),
    },
    {
      name: "Native Runtime (Tauri Backend)",
      path: path.resolve(rootDir, "src/backends/tauri.ts"),
    },
  ];

  for (const b of backends) {
    if (fs.existsSync(b.path)) {
      try {
        const res = await bundleApplication(b.path);
        printRow(b.name, res.total.rawSize, res.total.gzipSize, res.total.brotliSize);
        for (const file of res.files) {
          printRow(`  └ ${file.filename}`, file.rawSize, file.gzipSize, file.brotliSize);
        }
      } catch {
        printRow(b.name, "(build error)", "-", "-");
      }
    }
  }
  console.log("-".repeat(71));

  // 4. Distribution Assets
  const webDist = measureDistAssets(path.resolve(rootDir, "dist/web/assets"));
  if (webDist && webDist.files.length > 0) {
    printHeader("[4] Production Assets (dist/web/assets)");
    for (const file of webDist.files) {
      printRow(file.name, file.rawSize, file.gzipSize, file.brotliSize);
    }
    console.log("-".repeat(71));
    printRow(
      "TOTAL (Web Assets)",
      webDist.total.rawSize,
      webDist.total.gzipSize,
      webDist.total.brotliSize,
    );
    console.log("-".repeat(71));
  }

  const nativeDist = measureDistAssets(path.resolve(rootDir, "dist/native/assets"));
  if (nativeDist && nativeDist.files.length > 0) {
    printHeader("[5] Production Assets (dist/native/assets)");
    for (const file of nativeDist.files) {
      printRow(file.name, file.rawSize, file.gzipSize, file.brotliSize);
    }
    console.log("-".repeat(71));
    printRow(
      "TOTAL (Native Assets)",
      nativeDist.total.rawSize,
      nativeDist.total.gzipSize,
      nativeDist.total.brotliSize,
    );
    console.log("-".repeat(71));
  }

  console.log(`\n${"=".repeat(71)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
