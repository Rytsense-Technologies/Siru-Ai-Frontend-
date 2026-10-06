// Bug #12: a "Cart updated" receipt belongs to the turn that changed the cart. It used to be
// decided only by comparing the cart with the last one billed (shop.billedKey), which only
// turns update - so a change made OUTSIDE the chat (the nearby dialog, a Confirm tap, a
// reorder, another tab or a voice turn picked up by the refresh poll) was claimed by the next
// unrelated turn ("what are your timings?" -> "Cart updated · 51 items"). Now the turn's own
// trace says whether it wrote app_buyer_carts; with no trace (or a capped one) the cart's key
// decides, as before. Order receipts are unchanged.
// The page's own code runs (shoppingTurnFinish, shoppingTurnReceipts, shoppingRefresh, the
// Confirm card, shoppingReorder, the nearby dialog); only the API is stood in for.
const { test, expect } = require('@playwright/test');

let api;
const CART_WRITE = {kind: 'tool', name: 'add_to_cart', status: 'done', tables_read: [], tables_written: ['app_buyer_carts'],
                    table_planes: {app_buyer_carts: 'ai'}};
const NO_WRITE = {kind: 'route', name: 'pre_router', status: 'done', tables_read: [], tables_written: []};
const READS_CART = {kind: 'data', name: 'database', status: 'done', tables_read: ['app_buyer_carts'], tables_written: []};

test.beforeEach(async ({ page }) => {
  api = {qty: 50, cleared: false, orders: [], reorders: 0};
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS'};
  const cart = () => ({storeId: 'store-arun', items: api.cleared ? [] : [{item_id: 'cet', name: 'Cetirizine 10 mg', qty: api.qty, unit_price_paise: 2200}]});
  await page.exposeFunction('setServerQty', q => { api.qty = q; });
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (method === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/pharmacy/products') return route.fulfill({headers: cors, json: []});
    if (path === '/v1/pharmacy/cart/buyer-a/bill') {
      const total = api.cleared ? 0 : 2200 * api.qty;
      return route.fulfill({headers: cors, json: {cart: cart(), bill: {subtotalPaise: total, deliveryPaise: 0, totalPaise: total}, delivery: {address: ''}}});
    }
    if (path === '/v1/pharmacy/cart/buyer-a') return route.fulfill({headers: cors, json: cart()});
    if (path === '/v1/pharmacy/orders/buyer-a/DEMO-OLD/reorder' && method === 'POST') {
      api.reorders += 1;
      api.qty += 2;  // the reorder's items put back in the cart, outside any chat turn
      return route.fulfill({headers: cors, json: {order: 'DEMO-OLD', added: [{name: 'Cetirizine 10 mg', qty: 2}], skipped: [], cart: cart()}});
    }
    if (path === '/v1/actions/orders' && method === 'POST') {
      api.orders.push(1);
      return route.fulfill({headers: cors, json: {action: {id: 'act-1', kind: 'order', status: 'pending', display: {price_changed: false, price_changes: []}},
                                                  card: {kind: 'confirm_action', actionId: 'act-1', rows: []}}});
    }
    if (path === '/v1/actions/act-1/confirm' && method === 'POST') {
      api.cleared = true;  // the demo order empties the cart (actions/service.py)
      return route.fulfill({headers: cors, json: {action: {id: 'act-1', status: 'confirmed'}, order: {orderNumber: 'DEMO-9', totalPaise: 110000, demo: true}}});
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
    // A first answered turn that changed nothing: the cart as it stands is the one billed.
    shoppingTurn('t-0', {userText: 'hello'});
    await shoppingTurnFinish('t-0', {reply: 'Hi.', trace: {agent: 'x', steps: []}});
    // An answered chat turn, finished through the page's own handler.
    window.answer = async (id, text, trace) => {
      shoppingTurn(id, {userText: text});
      await shoppingTurnFinish(id, {reply: 'ok', trace});
      const turn = shoppingTurn(id);
      return {receipts: turn.record.receipts.length, text: turn.el.innerText.replace(/\s+/g, ' ')};
    };
  });
});

const say = (page, id, text, trace) => page.evaluate(([id, text, trace]) => answer(id, text, trace), [id, text, trace]);
const outsideChange = (page, qty) => page.evaluate(async qty => { await setServerQty(qty); await shoppingRefresh(); }, qty);

test('a cart change made outside the chat is not claimed by the next unrelated turn', async ({ page }) => {
  await outsideChange(page, 51);
  expect(await page.evaluate(() => shopEl.cartCount.textContent)).toBe('51');
  const timings = await say(page, 't-1', 'what are your timings?', {agent: 'supervisor', steps: [NO_WRITE, READS_CART]});
  expect(timings.receipts).toBe(0);
  expect(timings.text).not.toContain('Cart updated');
  // ...and the turn after it has nothing to claim either.
  expect((await say(page, 't-2', 'thanks', {agent: 'supervisor', steps: [NO_WRITE]})).receipts).toBe(0);
});

test('a turn that wrote the cart gets its receipt', async ({ page }) => {
  await page.evaluate(() => setServerQty(51));  // the turn's own add, on the server
  const add = await say(page, 't-1', 'add one more Cetirizine', {agent: 'commerce_agent', steps: [NO_WRITE, CART_WRITE]});
  expect(add.receipts).toBe(1);
  expect(add.text).toContain('Cart updated · 51 items');
});

test('an outside change and then a turn that writes the cart: one receipt, the whole cart', async ({ page }) => {
  await outsideChange(page, 51);
  await page.evaluate(() => setServerQty(52));
  const add = await say(page, 't-1', 'add one more Cetirizine', {agent: 'commerce_agent', steps: [CART_WRITE]});
  expect(add.receipts).toBe(1);
  expect(add.text).toContain('Cart updated · 52 items');
});

test('without a trace - or with a capped one - the cart key decides, as before', async ({ page }) => {
  await outsideChange(page, 51);
  expect((await say(page, 't-1', 'no trace', null)).receipts).toBe(1);
  await outsideChange(page, 52);
  expect((await say(page, 't-2', 'capped', {agent: 'x', steps: [NO_WRITE], steps_dropped: 3})).receipts).toBe(1);
});

test('the nearby dialog checkout outside the chat: the next unrelated turn gets no receipt', async ({ page }) => {
  await page.evaluate(() => shopFlowOpen('checkout'));
  await page.locator('#shopDialog input[name="shopPayment"][value="cod"]').check();
  await page.locator('#shopDialog .shop-place').click();
  await expect(page.locator('#shopTitle')).toHaveText('Order placed');
  await page.evaluate(() => document.getElementById('shopDialog').close());
  const next = await say(page, 't-1', 'show nearby pharmacies', {agent: 'direct_tool:nearby_pharmacies', steps: [NO_WRITE]});
  expect(next.receipts).toBe(0);
  expect(next.text).not.toContain('Cart updated');
});

test("an order placed in the turn keeps its order receipt", async ({ page }) => {
  const placed = {kind: 'tool', name: 'create_order', status: 'done', tables_written: ['app_buyer_carts'],
                  result: {status: 'placed', orderNumber: 'DEMO-7', orderTotalPaise: 110000, items: []}};
  await page.evaluate(() => setServerQty(50));
  const order = await say(page, 't-1', 'place my order', {agent: 'direct_tool:create_order', steps: [placed]});
  expect(order.receipts).toBe(1);  // the order's receipt - never a cart bill beside it
});

test('a Confirm tap outside the chat (a refill basket) is not claimed by the next turn', async ({ page }) => {
  await page.evaluate(write => {
    concierge.turn = async () => {  // the tap's own traced turn (/v1/concierge/turn), stood in for
      await setServerQty(53);
      return {text: 'Done.', cards: [{kind: 'action_result', added: [{name: 'Cetirizine 10 mg', status: 'added'}], skipped: []}],
              trace: {agent: 'confirm_action', steps: [write]}};
    };
    const card = shoppingUiCard({kind: 'confirm_action', actionId: 'act-r', action: 'refill_basket',
      title: 'Your refill, ready to check', summary: 'Add 1 refill item', rows: [], buttons: [
        {label: 'Confirm', intent: 'confirm_action', payload: {actionId: 'act-r'}, style: 'primary'},
        {label: 'Cancel', intent: 'cancel_action', payload: {actionId: 'act-r'}, style: 'ghost'}]}, new Date().toISOString());
    card.id = 'refill-card';
    shopEl.chatMessages.append(card);
  }, CART_WRITE);
  await page.locator('#refill-card button', {hasText: 'Confirm'}).click();
  await expect(page.locator('#refill-card')).toContainText('Added to your cart');
  await expect.poll(() => page.evaluate(() => shopEl.cartCount.textContent)).toBe('53');
  const next = await say(page, 't-1', 'what are your timings?', {agent: 'supervisor', steps: [NO_WRITE]});
  expect(next.receipts).toBe(0);
});

test('a reorder from the Orders screen is not claimed by the next turn', async ({ page }) => {
  await page.evaluate(async () => {
    const button = document.createElement('button');
    await shoppingReorder('DEMO-OLD', 'DEMO-OLD', button);
  });
  expect(api.reorders).toBe(1);
  await expect.poll(() => page.evaluate(() => shopEl.cartCount.textContent)).toBe('52');
  const next = await say(page, 't-1', 'what are your timings?', {agent: 'supervisor', steps: [NO_WRITE]});
  expect(next.receipts).toBe(0);
});

test('a change from another tab or a voice turn, picked up when the page refreshes the cart, is not claimed', async ({ page }) => {
  await page.evaluate(() => setServerQty(55));
  // Back to this tab: the page's own refresh (the window focus handler, as the 2.5 s poll does).
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => page.evaluate(() => shopEl.cartCount.textContent)).toBe('55');
  const next = await say(page, 't-1', 'what are your timings?', {agent: 'supervisor', steps: [NO_WRITE]});
  expect(next.receipts).toBe(0);
});
