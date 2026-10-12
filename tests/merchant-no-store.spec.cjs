// 12 Oct, production: "Welcome, <store name>" over six "No store registered" panels. The heading was the signed-in
// account's configured name (GET /v1/auth/me); every section's 404 {"code": "no_store"} is the client database
// saying that account's user id owns no store. Now the overview shows one empty state that says so and what to do,
// the heading and sidebar no longer present the account as a found store, no figure is shown, and each section view
// keeps a one-line notice. The page's own code runs; only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'};
const NO_STORE = {detail: {code: 'no_store', message: 'No store is registered for this merchant account in the client database.'}};

async function openWithoutAStore(page) {
  const reads = [];
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/auth/me') return route.fulfill({headers: cors, json: {id: 'merchant-x', name: 'Test Pharmacy', email: 'owner@example.test', role: 'merchant'}});
    if (path === '/v1/merchant/me/stores') return route.fulfill({headers: cors, json: {stores: []}});
    if (path.startsWith('/v1/merchant/')) { reads.push(path); return route.fulfill({status: 404, headers: cors, json: NO_STORE}); }
    return route.fulfill({headers: cors, json: {}});
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token-x', expires_at: Date.now() / 1000 + 3600,
              user: {id: 'merchant-x', role: 'merchant', name: 'Test Pharmacy', email: 'owner@example.test'}});
    await applySignedInUser();
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  });
  return reads;
}

test('a merchant whose account owns no store gets one empty state with the next step, and no figures', async ({ page }) => {
  const reads = await openWithoutAStore(page);
  const empty = page.locator('.m-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('Ask your Siru administrator to link owner@example.test to your store.');
  await expect(empty).toContainText('No figures are shown or estimated until then.');
  // The account's name is not presented as a store that was found.
  await expect(page.locator('#merchantTitle')).toHaveText('No store linked to this sign-in');
  await expect(page.locator('#merchantName')).toHaveText('No store linked');
  await expect(page.locator('#merchantBody')).not.toContainText('Welcome');
  await expect(page.locator('#merchantBody')).not.toContainText('₹');
  await expect(page.locator('.m-panel')).toHaveCount(0);           // not five panels saying it again
  await expect(page.locator('#merchantNotice')).toBeHidden();      // the card says it once

  // The page's own Refresh reads again (a linked store would then load).
  const before = reads.length;
  await page.locator('#merchantRefresh').click();
  await expect.poll(() => reads.length).toBeGreaterThan(before);
  await expect(empty).toBeVisible();
});

test('a section view of a merchant without a store keeps the one-line notice with the next step', async ({ page }) => {
  await openWithoutAStore(page);
  await expect(page.locator('.m-empty')).toBeVisible();
  await page.locator('[data-mview="earnings"]').click();
  const notice = page.locator('#merchantNotice');
  await expect(notice).toContainText('No store is registered for this merchant account in the client database.');
  await expect(notice).toContainText('not linked to a store owner yet - ask your Siru administrator');
  await expect(notice).toContainText('Nothing on this page is estimated.');
  await expect(page.locator('#merchantBody')).not.toContainText('₹');
});
