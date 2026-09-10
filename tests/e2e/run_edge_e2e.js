// Cloudflare Pages entry smoke check. This checks the deployed HTML only;
// peer transfer and route selection must be tested with two devices.
const target = process.argv[2] || 'https://ponlet.mat2uken.app/';

(async () => {
  const response = await fetch(target, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Pages returned ${response.status} for ${target}`);
  }
  const html = await response.text();
  if (!html.includes('<title>Ponlet</title>')) {
    throw new Error('Pages response does not contain the current WebView entry point');
  }
  console.log(`Pages entry point passed: ${target} (${html.length} bytes)`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
