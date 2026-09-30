// Voice, end to end: this page -> the real /v1/voice/token -> the real LiveKit
// server -> the real voice worker (Sarvam STT, the graph, Sarvam TTS) -> the
// chat. The microphone is Chrome's FAKE capture device playing a SYNTHETIC
// speech file (E2E_VOICE_SAMPLES/<lang>.wav, made by the backend's
// scripts/e2e_voice_samples.py with Sarvam TTS) - real audio through the real
// pipeline, but not a physical microphone or a human voice.
//
// Needs E2E_VOICE=1, LiveKit and the voice worker running, and the samples.
const fs = require('node:fs');
const path = require('node:path');
const { test, chromium } = require('@playwright/test');
const { env, signIn, SCRIPTS, expect } = require('./helpers.cjs');

const VOICE = process.env.E2E_VOICE === '1';
const SAMPLES = process.env.E2E_VOICE_SAMPLES || '';
const LANGUAGES = [
  // [sample, the language its reply must be in, a word the transcript must have]
  ['en-IN', null, /dolo/i],
  ['ta-IN', 'ta-IN', /./],
  ['hi-IN', 'hi-IN', /./],
  ['te-IN', 'te-IN', /./],
];

async function withFakeMicrophone(sample, run) {
  const browser = await chromium.launch({
    channel: process.env.PW_CHANNEL || undefined,
    headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${sample}`, '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext({ permissions: ['microphone'] });
    await run(await context.newPage());
  } finally {
    await browser.close();
  }
}

test.describe.serial('voice', () => {
  test.skip(!VOICE, 'needs LiveKit, the voice worker and Sarvam (E2E_VOICE=1) - not run, not passed');

  test('mic: greeting, then a spoken turn answered in its own language, for each language', async () => {
    const [a] = env().accounts;
    for (const [language, replyLanguage, heard] of LANGUAGES) {
      const sample = path.join(SAMPLES, `${language}.wav`);
      expect(fs.existsSync(sample), `${sample} (scripts/e2e_voice_samples.py)`).toBe(true);
      await withFakeMicrophone(sample, async page => {
        await signIn(page, a);
        // Messages outside any turn: the spoken greeting (nothing is typed on sign-in).
        const greetings = page.locator('#chatMessages > .chat-entry.assistant .chat-bubble.assistant');
        const before = await greetings.count();
        const token = page.waitForResponse(r => r.url().includes('/v1/voice/token'));
        await page.click('#micBtn');
        expect((await token).status()).toBe(200);
        // The first mic tap of a sign-in greets (once): it is in the chat too.
        await expect.poll(() => greetings.count(), { timeout: 60_000 }).toBeGreaterThan(before);
        // The spoken turn: its transcript as the user's message, then the reply.
        const voiceTurn = page.locator('.chat-turn').filter({ has: page.locator('.chat-bubble.user') }).last();
        await expect(voiceTurn.locator('.chat-bubble.user')).toHaveText(heard, { timeout: 90_000 });
        const reply = voiceTurn.locator('.chat-bubble.assistant');
        await expect(reply).toBeVisible({ timeout: 90_000 });
        const text = (await reply.textContent()).trim();
        if (replyLanguage) expect(text, language).toMatch(SCRIPTS[replyLanguage]);
        else for (const script of Object.values(SCRIPTS)) expect(text, language).not.toMatch(script);
        await page.click('#micBtn');  // stop
      });
    }
  });
});
