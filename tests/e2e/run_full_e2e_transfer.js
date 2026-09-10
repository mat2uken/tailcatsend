// Browser UI smoke entry point. A successful UI load does not prove a peer transfer.
// Run the two-device matrix only after supplying live peers and a test file.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

execFileSync('npm', ['run', 'test:e2e'], {
  cwd: path.resolve(__dirname, '../../web-ui'),
  stdio: 'inherit',
});
