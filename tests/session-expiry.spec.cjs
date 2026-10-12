// A sign-in that ran out while the page was closed (12 Oct audit): the reload showed the sign-in form with no
// word of why, and kept the stale record. Now it says the session expired - as a live expiry does
// (user-menu.js authExpired) - and the record is gone. A current sign-in is unaffected.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'};

test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname.startsWith('/v1/'), route => route.request().method() === 'OPTIONS'
    ? route.fulfill({status: 204, headers: cors})
    : route.fulfill({status: 404, headers: cors, json: {detail: 'Not Found'}}));
  await page.goto('/index.html');
  await page.waitForLoadState('load');
});

const stored = page => page.evaluate(() => Object.keys(sessionStorage).filter(k => (sessionStorage.getItem(k) || '').includes('token-')));

test('a session that expired while the page was closed says so on the sign-in form, and is not kept', async ({ page }) => {
  await page.evaluate(() => authSave({access_token: 'token-old', expires_at: Date.now() / 1000 - 60,
                                      user: {id: 'buyer-x', role: 'buyer', name: 'X'}}));
  expect((await stored(page)).length).toBe(1);
  await page.reload();
  await expect(page.locator('#loginView')).toBeVisible();
  await expect(page.locator('#loginError')).toHaveText('Your session has expired. Please sign in again.');
  expect(await stored(page)).toEqual([]);
});

test('a first visit has no expiry message', async ({ page }) => {
  await expect(page.locator('#loginView')).toBeVisible();
  await expect(page.locator('#loginError')).toBeHidden();
});
