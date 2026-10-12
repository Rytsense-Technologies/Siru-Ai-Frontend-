// 12 Oct, production: "Welcome, <store name>" over six "No store registered" panels. The heading is the signed-in
// account's configured name (GET /v1/auth/me); every section's 404 {"code": "no_store"} is the client database
// saying that account's user id owns no store. The page now says so once, with the next step, and shows no figure.
// The page's own code runs; only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'};
const NO_STORE = {detail: {code: 'no_store', message: 'No store is registered for this merchant account in the client database.'}};

test('a merchant whose account owns no store is told why and what to do, with no figures', async ({ page }) => {
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/auth/me') return route.fulfill({headers: cors, json: {id: 'merchant-x', name: 'Test Pharmacy', role: 'merchant'}});
    if (path === '/v1/merchant/me/stores') return route.fulfill({headers: cors, json: {stores: []}});
    if (path.startsWith('/v1/merchant/')) return route.fulfill({status: 404, headers: cors, json: NO_STORE});
    return route.fulfill({headers: cors, json: {}});
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token-x', expires_at: Date.now() / 1000 + 3600,
              user: {id: 'merchant-x', role: 'merchant', name: 'Test Pharmacy'}});
    await applySignedInUser();
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  });

  const notice = page.locator('#merchantNotice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('No store is registered for this merchant account in the client database.');
  await expect(notice).toContainText('not linked to a store owner yet - ask your Siru administrator');
  await expect(notice).toContainText('Nothing on this page is estimated.');
  await expect(page.locator('#merchantBody')).not.toContainText('₹');  // no fabricated figure

  // A section view says the same, not only the overview.
  await page.locator('[data-mview="earnings"]').click();
  await expect(notice).toContainText('ask your Siru administrator');
});
