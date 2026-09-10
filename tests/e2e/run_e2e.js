// Static WebView artifact smoke check.
// Communication and transport-path tests require two running peers and are kept separate.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const index = path.join(root, 'web-ui', 'dist', 'web', 'index.html');
const bundle = path.join(root, 'web-ui', 'dist', 'web', 'assets', 'index.js');

for (const file of [index, bundle]) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing WebView artifact: ${file}. Run scripts/build_web_ui.sh first.`);
  }
}
const html = fs.readFileSync(index, 'utf8');
const javascript = fs.readFileSync(bundle, 'utf8');
if (!html.includes('<title>Ponlet</title>') || !javascript.includes('Ponlet')) {
  throw new Error('The generated WebView bundle does not contain the Ponlet entry point');
}
console.log(`WebView artifacts are present: ${path.relative(root, index)} and ${path.relative(root, bundle)}`);
