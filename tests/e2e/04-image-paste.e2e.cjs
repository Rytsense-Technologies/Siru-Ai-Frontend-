// A photo pasted with Ctrl+V: the image goes onto the browser's REAL clipboard
// (navigator.clipboard.write) and the message box receives a real paste event -
// the path a user takes. Attach / remove / refuse run anywhere; reading the
// photo needs the vision model (E2E_LLM=1).
const { test } = require('@playwright/test');
const { env, signIn, expect } = require('./helpers.cjs');

const LLM = process.env.E2E_LLM === '1';

// A medicine pack's front, drawn in the page: a PNG or JPEG blob.
async function copyImage(page, type, lines) {
  await page.evaluate(async ({ type, lines }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#b00020'; g.fillRect(0, 0, 640, 70);
    g.fillStyle = '#fff'; g.font = 'bold 44px Arial'; g.fillText(lines[0], 24, 52);
    g.fillStyle = '#111'; g.font = '30px Arial';
    lines.slice(1).forEach((line, i) => g.fillText(line, 24, 130 + i * 48));
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.92));
    // The clipboard takes PNG; a JPEG is carried as a PNG-typed item is not
    // possible, so JPEG goes through the file picker path below instead.
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }, { type, lines });
}

test.describe.serial('image paste', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write', 'microphone'] });

  test('Ctrl+V of a PNG attaches it; remove takes it away; nothing is sent', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    await copyImage(page, 'image/png', ['DOLO 650', 'Paracetamol Tablets IP 650 mg', '15 tablets']);
    await page.focus('#askInput');
    await page.keyboard.press('Control+V');
    await expect(page.locator('#attachPreview')).toBeVisible();
    await expect(page.locator('#attachImg')).toHaveAttribute('src', /^blob:/);
    await page.click('#attachRemove');
    await expect(page.locator('#attachPreview')).toBeHidden();
    await expect(page.locator('.chat-bubble.user', { hasText: 'Photo:' })).toHaveCount(0);
  });

  test('an unsupported type (GIF) is refused with a reason, before any upload', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    const uploads = [];
    page.on('request', r => { if (r.url().includes('/v1/concierge/turn') && (r.postData() || '').includes('upload')) uploads.push(r); });
    await page.setInputFiles('#rxFile', { name: 'pack.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;') });
    await expect(page.locator('#attachPreview')).toBeHidden();
    await expect(page.locator('body')).toContainText(/JPEG|PNG|photo/i);
    expect(uploads).toEqual([]);
  });

  test('a pasted medicine photo is read and looked up in the catalog', async ({ page }) => {
    test.skip(!LLM, 'needs the vision model (E2E_LLM=1 with GEMINI_API_KEY) - not run, not passed');
    const [a] = env().accounts;
    await signIn(page, a);
    await copyImage(page, 'image/png', ['DOLO 650', 'Paracetamol Tablets IP 650 mg', '15 tablets']);
    await page.focus('#askInput');
    await page.keyboard.press('Control+V');
    await expect(page.locator('#attachPreview')).toBeVisible();
    await page.press('#askInput', 'Enter');
    const turn = page.locator('.chat-turn').filter({ has: page.locator('.chat-bubble.user', { hasText: 'Photo:' }) }).last();
    const reply = turn.locator('.chat-bubble.assistant');
    await expect(reply).toBeVisible({ timeout: 120_000 });
    expect((await reply.textContent()).toLowerCase()).toMatch(/dolo|paracetamol/);
  });

  test('a JPEG from the file picker is read too', async ({ page }) => {
    test.skip(!LLM, 'needs the vision model (E2E_LLM=1 with GEMINI_API_KEY) - not run, not passed');
    const [a] = env().accounts;
    await signIn(page, a);
    const jpeg = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 300;
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 300);
      g.fillStyle = '#111'; g.font = 'bold 48px Arial'; g.fillText('CROCIN ADVANCE', 20, 120);
      g.font = '30px Arial'; g.fillText('Paracetamol 500 mg - 15 tablets', 20, 190);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await page.setInputFiles('#rxFile', { name: 'crocin.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg) });
    await expect(page.locator('#attachPreview')).toBeVisible();
    await page.press('#askInput', 'Enter');
    const turn = page.locator('.chat-turn').filter({ has: page.locator('.chat-bubble.user', { hasText: 'Photo:' }) }).last();
    await expect(turn.locator('.chat-bubble.assistant')).toBeVisible({ timeout: 120_000 });
  });
});
