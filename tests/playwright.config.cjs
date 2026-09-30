// Browser tests for the static site, in a real browser with the page's real
// Content-Security-Policy (dev/serve.py sends vercel.json's).
//   npm run test:browser                  (PW_CHANNEL=chrome to use an installed Chrome)
// tests/*.spec.cjs here need no backend; the full-stack suite (real API,
// voice worker, LiveKit, databases) is the backend repo's tests/e2e.
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.SIRU_STATIC_PORT || 5510);

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.cjs$/,
  testIgnore: /e2e[\/]/,
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.PW_CHANNEL || undefined,
    headless: true,
  },
  webServer: {
    command: `"${process.env.PYTHON || 'python'}" dev/serve.py --bind 127.0.0.1 --port ${PORT}`,
    cwd: require('node:path').resolve(__dirname, '..'),
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
