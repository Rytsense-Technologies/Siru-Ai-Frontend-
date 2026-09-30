// End-to-end: a real browser -> this frontend -> the REAL backend (and its
// databases, Redis, and - for the voice tests - LiveKit and the voice worker).
//
//   npm run test:e2e                       starts the API + static server itself (stack.cjs)
//   E2E_EXTERNAL=1 E2E_API_URL=... E2E_WEB_URL=... E2E_ACCOUNTS=<json> npm run test:e2e
//                                          against a stack already running (scripts\dev-start.cmd)
//
// Some tests need live services and say so when they skip - never a pass:
//   E2E_LLM=1    the model (GEMINI_API_KEY): a photo read, a symptom question
//   E2E_VOICE=1  LiveKit + the voice worker + Sarvam: a spoken turn, from a
//                SYNTHETIC audio file fed to the browser as its microphone
//                (Chrome's fake capture device) - not a physical microphone.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.cjs$/,
  globalSetup: require.resolve('./stack.cjs'),
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,  // one stack, shared accounts: the scenarios run in order
  reporter: [['list']],
  use: {
    channel: process.env.PW_CHANNEL || undefined,
    headless: process.env.E2E_HEADED !== '1',
    permissions: ['microphone'],
    launchOptions: {
      args: process.env.E2E_FAKE_AUDIO
        ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
          `--use-file-for-fake-audio-capture=${process.env.E2E_FAKE_AUDIO}`]
        : ['--use-fake-ui-for-media-stream'],
    },
  },
});
