// CI, 12 Oct (turn-receipts.spec.cjs: "a change from another tab ... picked up when the page refreshes the
// cart"): expected 55 items, the page kept 50. The focus handler's refresh was dropped because another refresh
// was still in flight (shop.refreshing) - and that one had read the cart before the other tab's change. Nothing
// read it again (the 2.5 s poll only runs with a loaded shelf). Here the race is made certain: a refresh whose
// server read saw 50 is held, the cart becomes 55, focus fires, the held answer arrives. A refresh asked for
// meanwhile now runs once more when the one in flight ends. Only the API is stood in for.
const { test, expect } = require('@playwright/test');

test('a refresh asked for while another is in flight is not dropped: the newer cart is shown', async ({ page }) => {
  const api = {qty: 50, hold: null};
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS'};
  await page.exposeFunction('setServerQty', q => { api.qty = q; });
  await page.exposeFunction('holdNextCartRead', () => { api.hold = 'armed'; });
  let release;
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/pharmacy/products') return route.fulfill({headers: cors, json: []});
    if (path === '/v1/pharmacy/cart/buyer-a') {
      // The server reads the cart NOW (qty at this moment); the answer may arrive later.
      const body = {storeId: 'store-arun', items: [{item_id: 'cet', name: 'Cetirizine 10 mg', qty: api.qty, unit_price_paise: 2200}]};
      if (api.hold === 'armed') { api.hold = 'held'; await new Promise(r => { release = r; }); }
      return route.fulfill({headers: cors, json: body});
    }
    return route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(async () => {
    authSave({access_token: 't', expires_at: Date.now() / 1000 + 3600, user: {id: 'buyer-a', role: 'buyer', name: 'buyer-a'}});
    await applySignedInUser();
    for (let i = 0; i < 40 && !locEl.locationDialog.open; i++) await new Promise(r => setTimeout(r, 50));
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    locationSave({source: 'manual', address: 'x', pincode: '600100', lat: 12.9, lng: 80.2});
    for (let i = 0; i < 40 && pharmacyApi.mode !== 'sandbox'; i++) await new Promise(r => setTimeout(r, 50));
    await shoppingRefresh();
  });
  await expect.poll(() => page.evaluate(() => shopEl.cartCount.textContent)).toBe('50');
  // A refresh starts; the server reads 50 for it, its answer is held.
  await page.evaluate(async () => { await holdNextCartRead(); shoppingRefresh(); });
  await expect.poll(() => api.hold).toBe('held');
  // Meanwhile another tab changes the cart, and this tab gets focus.
  await page.evaluate(async () => { await setServerQty(55); window.dispatchEvent(new Event('focus')); });
  release();
  await expect.poll(() => page.evaluate(() => shopEl.cartCount.textContent), {timeout: 5000}).toBe('55');
});

test('an awaited refresh asked for while another is in flight returns only once the newer cart is shown', async ({ page }) => {
  const api = {qty: 50, hold: null};
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS'};
  await page.exposeFunction('setServerQty', q => { api.qty = q; });
  await page.exposeFunction('holdNextCartRead', () => { api.hold = 'armed'; });
  let release;
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/pharmacy/products') return route.fulfill({headers: cors, json: []});
    if (path === '/v1/pharmacy/cart/buyer-a') {
      const body = {storeId: 'store-arun', items: [{item_id: 'cet', name: 'Cetirizine 10 mg', qty: api.qty, unit_price_paise: 2200}]};
      if (api.hold === 'armed') { api.hold = 'held'; await new Promise(r => { release = r; }); }
      return route.fulfill({headers: cors, json: body});
    }
    return route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(async () => {
    authSave({access_token: 't', expires_at: Date.now() / 1000 + 3600, user: {id: 'buyer-a', role: 'buyer', name: 'buyer-a'}});
    await applySignedInUser();
    for (let i = 0; i < 40 && !locEl.locationDialog.open; i++) await new Promise(r => setTimeout(r, 50));
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    locationSave({source: 'manual', address: 'x', pincode: '600100', lat: 12.9, lng: 80.2});
    for (let i = 0; i < 40 && pharmacyApi.mode !== 'sandbox'; i++) await new Promise(r => setTimeout(r, 50));
    await shoppingRefresh();
  });
  await page.evaluate(async () => { await holdNextCartRead(); shoppingRefresh(); });
  await expect.poll(() => api.hold).toBe('held');
  // The change, then a caller that awaits its own refresh (as an outside change's handler does).
  const shown = page.evaluate(async () => { await setServerQty(51); await shoppingRefresh(); return shopEl.cartCount.textContent; });
  await page.waitForTimeout(200);
  release();
  expect(await shown).toBe('51');   // not the in-flight read's 50
});
