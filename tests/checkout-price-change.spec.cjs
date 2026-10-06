// Bug #10: the nearby dialog's "Place order" prepares the order and confirms it at once. The
// checkout was drawn from the cart's stored prices; preparing re-prices the cart from the
// catalog. When the prepare says a price changed (action.display.price_changed - a flag, not
// the "Price updated" wording), the dialog must not confirm: it cancels that prepared order,
// says what changed and shows the checkout again at the new price; a second click orders.
// Unchanged prices: one click, as before. The page's own code runs; only the API is stood in for.
const { test, expect } = require('@playwright/test');

let api;

test.beforeEach(async ({ page }) => {
  api = {price: 3400, orders: [], confirms: [], cancels: [], bills: 0, prepare: []};
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS'};
  const cart = () => ({storeId: 'store-arun', items: [{item_id: 'dolo-arun', name: 'Dolo 650', qty: 2, unit_price_paise: api.price}]});
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (method === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/pharmacy/products') return route.fulfill({headers: cors, json: []});
    if (path === '/v1/pharmacy/cart/buyer-a/bill') {
      api.bills += 1;
      return route.fulfill({headers: cors, json: {cart: cart(), bill: {subtotalPaise: 2 * api.price, deliveryPaise: 0, totalPaise: 2 * api.price}, delivery: {address: ''}}});
    }
    if (path === '/v1/pharmacy/cart/buyer-a') return route.fulfill({headers: cors, json: cart()});
    if (path === '/v1/actions/orders' && method === 'POST') {
      api.orders.push(request.postDataJSON());
      const next = api.prepare.shift() || {status: 200, newPrice: api.price};
      if (next.status !== 200) return route.fulfill({status: next.status, headers: cors, json: {detail: next.detail}});
      const was = api.price;
      api.price = next.newPrice;  // the server re-prices the stored cart, as prepare_order does
      const changed = was !== api.price;
      const id = `act-${api.orders.length}`;
      return route.fulfill({headers: cors, json: {
        action: {id, kind: 'order', status: 'pending', summary: 'Place an order for 1 item',
                 display: {title: 'Confirm your order', rows: [], price_changed: changed,
                           price_changes: changed ? [{name: 'Dolo 650', was_paise: was, now_paise: api.price}] : []}},
        card: {kind: 'confirm_action', actionId: id, action: 'order', rows: []}}});
    }
    const m = path.match(/^\/v1\/actions\/([^/]+)\/(confirm|cancel)$/);
    if (m && method === 'POST') {
      api[m[2] === 'confirm' ? 'confirms' : 'cancels'].push(m[1]);
      return route.fulfill({headers: cors, json: m[2] === 'confirm'
        ? {action: {id: m[1], status: 'confirmed'}, order: {orderNumber: 'DEMO-1', totalPaise: 2 * api.price, demo: true}}
        : {action: {id: m[1], status: 'cancelled'}}});
    }
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token-buyer-a', expires_at: Date.now() / 1000 + 3600, user: {id: 'buyer-a', role: 'buyer', name: 'buyer-a'}});
    await applySignedInUser();
    for (let i = 0; i < 40 && !locEl.locationDialog.open; i++) await new Promise(resolve => setTimeout(resolve, 50));
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    locationSave({source: 'manual', address: 'Pallikaranai Main Road, Chennai', pincode: '600100', lat: 12.9352, lng: 80.2108});
    for (let i = 0; i < 40 && pharmacyApi.mode !== 'sandbox'; i++) await new Promise(resolve => setTimeout(resolve, 50));
    await shoppingRefresh();
  });
});

async function placeOrder(page) {
  await page.evaluate(() => shopFlowOpen('checkout'));
  await page.locator('#shopDialog input[name="shopPayment"][value="cod"]').check();
  const place = page.locator('#shopDialog .shop-place');
  await expect(place).toBeEnabled();
  await place.click();
}

test('a price changed at prepare: cancelled, not confirmed, said, checkout shown again at the new price', async ({ page }) => {
  api.prepare = [{status: 200, newPrice: 3900}];
  await placeOrder(page);
  const notice = page.locator('#shopDialog .shop-price-notice');
  await expect(notice).toHaveText('Prices changed since you opened checkout: Dolo 650 ₹34.00 → ₹39.00. Review the new total and place the order again.');
  await expect(page.locator('#shopTitle')).toHaveText('Checkout');
  await expect(page.locator('#shopDialog .shop-total')).toContainText('₹78.00');  // redrawn from the re-priced cart
  expect(api.cancels).toEqual(['act-1']);
  expect(api.confirms).toEqual([]);
  expect(api.orders).toHaveLength(1);
  expect(api.bills).toBeGreaterThanOrEqual(2);

  // The second click, the price as shown now: ordered once.
  await page.locator('#shopDialog input[name="shopPayment"][value="cod"]').check();
  await page.locator('#shopDialog .shop-place').click();
  await expect(page.locator('#shopTitle')).toHaveText('Order placed');
  expect(api.confirms).toEqual(['act-2']);
  expect(api.cancels).toEqual(['act-1']);
  expect(api.orders).toHaveLength(2);
});

test('an unchanged price: one click, confirmed exactly once, nothing cancelled', async ({ page }) => {
  await placeOrder(page);
  await expect(page.locator('#shopTitle')).toHaveText('Order placed');
  await expect(page.locator('#shopDialog .shop-price-notice')).toHaveCount(0);
  expect(api.orders).toHaveLength(1);
  expect(api.confirms).toEqual(['act-1']);
  expect(api.cancels).toEqual([]);
});

test('a 409 at prepare still shows its message, and nothing is confirmed or cancelled', async ({ page }) => {
  api.prepare = [{status: 409, detail: "Dolo 650 can't be ordered right now. Please remove it from your cart and try again."}];
  await placeOrder(page);
  await expect(page.locator('#shopTitle')).toHaveText('Order not placed');
  await expect(page.locator('#shopDialog')).toContainText("Dolo 650 can't be ordered right now. Please remove it from your cart and try again.");
  expect(api.confirms).toEqual([]);
  expect(api.cancels).toEqual([]);
});

test('a double click makes one prepare, and never a second confirm or cancel', async ({ page }) => {
  api.prepare = [{status: 200, newPrice: 3900}];
  await page.evaluate(() => shopFlowOpen('checkout'));
  await page.locator('#shopDialog input[name="shopPayment"][value="cod"]').check();
  await page.locator('#shopDialog .shop-place').dblclick();
  await expect(page.locator('#shopDialog .shop-price-notice')).toBeVisible();
  expect(api.orders).toHaveLength(1);
  expect(api.cancels).toEqual(['act-1']);
  expect(api.confirms).toEqual([]);
});
