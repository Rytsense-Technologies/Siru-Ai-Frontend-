// Each message is answered in its own language - on the fast routes too - and
// the Inspector shows what the server observed, never a guessed table.
const { test } = require('@playwright/test');
const { env, signIn, say, SCRIPTS, expect } = require('./helpers.cjs');

test.describe.serial('per-turn language and the Inspector', () => {
  test('one chat, English -> romanized Hindi -> romanized Tamil -> romanized Telugu -> English', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    const turns = [
      ['show my cart', null],
      ['mera cart dikhao', 'hi-IN'],
      ['cart kaatunga', 'ta-IN'],
      ['naa cart chupinchu', 'te-IN'],
      ['show my cart please', null],
    ];
    for (const [text, language] of turns) {
      const { text: reply } = await say(page, text);
      if (language) expect(reply, text).toMatch(SCRIPTS[language]);
      else for (const script of Object.values(SCRIPTS)) expect(reply, text).not.toMatch(script);
    }
  });

  test('the Inspector names only tables the server observed', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    await say(page, 'show my cart');
    await page.click('#activityBtn');
    const panel = page.locator('#activityPanel');
    await expect(panel).toBeVisible();
    const text = await panel.textContent();
    expect(text).not.toContain('checkpointer.put');  // a row the page used to invent
    // The stored trace (as the page keeps it) has no table the server didn't report.
    const trace = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('siru_activity_'));
      return key ? JSON.parse(localStorage.getItem(key)).at(-1).trace : null;
    });
    expect(trace).toBeTruthy();
    for (const call of trace.io?.calls || []) {
      for (const table of [...(call.tables_read || []), ...(call.tables_written || [])]) {
        expect(call.table_planes?.[table], `${call.name}: ${table} has a plane (observed)`).toBeTruthy();
      }
    }
  });
});
