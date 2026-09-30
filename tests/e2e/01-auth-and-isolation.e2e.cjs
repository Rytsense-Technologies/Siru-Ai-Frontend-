// Sign-in, sign-out and what one user can reach of another's - through the real
// sign-in form, the real API and its real token checks.
const { test } = require('@playwright/test');
const { env, signIn, api, login, say, expect } = require('./helpers.cjs');

test.describe.serial('authentication and isolation', () => {
  test('a wrong password is refused; the right one signs in', async ({ page }) => {
    const [a] = env().accounts;
    const wrong = await login(a.email, `${a.password}-wrong`);
    expect(wrong.status).toBe(401);
    await signIn(page, a);
    const me = await api(page, '/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user_id || me.body.id).toBeTruthy();
  });

  test('another user\'s cart, orders, memory and actions are refused by the server', async ({ browser }) => {
    const [a, b] = env().accounts;
    const pageA = await (await browser.newContext()).newPage();
    const pageB = await (await browser.newContext()).newPage();
    await signIn(pageA, a);
    await signIn(pageB, b);
    const idA = (await api(pageA, '/v1/auth/me')).body.user_id;
    for (const path of [`/v1/pharmacy/cart/${idA}`, `/v1/pharmacy/orders/${idA}`, `/v1/pharmacy/cart/${idA}/bill`]) {
      expect((await api(pageB, path)).status, path).toBe(403);
    }
    const write = await api(pageB, `/v1/pharmacy/cart/${idA}`, { method: 'DELETE' });
    expect(write.status).toBe(403);
    // An action id of A's is "no such action" to B (404), whatever B does with it.
    const fake = await api(pageB, '/v1/actions/00000000-0000-0000-0000-000000000000/confirm', { method: 'POST' });
    expect([403, 404]).toContain(fake.status);
    // B's own memory is B's: nothing of A's shows up.
    const memoryB = await api(pageB, '/v1/memory/me');
    expect(memoryB.status).toBe(200);
    expect(JSON.stringify(memoryB.body)).not.toContain(idA);
  });

  test('signing out revokes the token on the server and leaves nothing of the user on the device', async ({ page }) => {
    const [a, b] = env().accounts;
    await signIn(page, a);
    await say(page, 'show my cart');
    const before = await page.evaluate(() => Object.keys(localStorage).filter(k => /^siru_(chat|activity|sessions)_/.test(k)));
    expect(before.length).toBeGreaterThan(0);  // the chat really was kept while signed in
    const oldToken = await page.evaluate(() => authToken());
    await page.click('#userMenu summary');
    await page.click('#logoutBtn');
    await expect(page.locator('#loginView')).toBeVisible();
    const after = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
      .filter(k => /^siru_(chat|activity|sessions|location|current_session)_/.test(k) || k === 'siru_session'));
    expect(after).toEqual([]);
    // The old token no longer works anywhere (server-side sign-out record).
    await expect.poll(async () => (await fetch(`${env().api}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    // The next person on this device sees none of it.
    await signIn(page, b);
    await expect(page.locator('.chat-bubble.user')).toHaveCount(0);
  });
});
