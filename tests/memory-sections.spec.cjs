// The Memory tab's sections are each their own source, and say honestly what
// they have: household profiles (GET /v1/household/me), the cart, and the
// orders (SIRU + this app's confirmed ones). Loading, empty and failed differ;
// a failure is never shown as "none"; another user's records never stay on
// screen - not after a switch, not after signing out. Only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, PATCH, OPTIONS'};
let api;  // per user: {household, siruOrders, demo} - a value, or a status number to fail with

const member = (id, label, extra = {}) => ({id, relationship: 'mother', label, age_years: null, note: '',
  source: 'user_entered', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', ...extra});

test.beforeEach(async ({ page }) => {
  api = new Map();
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    const user = String(request.headers().authorization || '').replace('Bearer token-', '');
    const mine = api.get(user) || {};
    const answer = value => typeof value === 'number' || value === undefined
      ? route.fulfill({status: value || 503, headers: cors, json: {detail: 'unavailable'}})
      : (value.then ? value.then(v => route.fulfill({headers: cors, json: v})) : route.fulfill({headers: cors, json: value}));
    if (path === '/v1/household/me' && request.method() === 'GET') {
      const h = mine.household;
      return answer(typeof h === 'number' || h === undefined ? h : (h.then ? h.then(members => ({members})) : {members: h}));
    }
    if (path.startsWith('/v1/household/me/') && request.method() === 'DELETE') {
      const id = path.split('/').pop();
      mine.household = (mine.household || []).filter(m => m.id !== id);
      return route.fulfill({headers: cors, json: {deleted: true, id}});
    }
    if (path.startsWith('/v1/pharmacy/orders/')) return answer(mine.siruOrders);
    if (path === '/v1/actions/demo') return answer(mine.demo);
    if (path === '/v1/memory/me') return route.fulfill({headers: cors, json: {items: [], memory_enabled: true}});
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    window.signInAs = async id => {
      authSave({access_token: `token-${id}`, expires_at: Date.now() / 1000 + 3600, user: {id, role: 'buyer', name: id}});
      await applySignedInUser();
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    };
    window.settle = () => new Promise(resolve => setTimeout(resolve, 150));
    window.sections = () => ({
      household: [...memoryEl.householdList.querySelectorAll('.memory-text')].map(n => n.textContent),
      householdCount: memoryEl.householdCount.textContent,
      householdEmpty: !memoryEl.householdEmpty.hidden,
      householdStatus: memoryEl.householdStatus.textContent,
      orders: memoryEl.memoryOrders.textContent,
      cart: memoryEl.memoryCart.textContent,
      stm: memoryEl.stmRecent.children.length,
    });
  });
});

test('household profiles the user entered are listed with their details, and one can be deleted', async ({ page }) => {
  api.set('a', {household: [member('m1', 'Amma', {age_years: 62, note: 'prefers syrups'}), member('m2', 'Kavin', {relationship: 'son'})],
    siruOrders: [], demo: {orders: [], bookings: []}});
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => signInAs('a'));
  // No saved location: sign-in asks for one (location-ui.js). Dismiss it, as a user would.
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
  const shown = await page.evaluate(async () => { panelShow('memory'); await householdRefresh(); return sections(); });
  expect(shown).toMatchObject({household: ['Amma', 'Kavin'], householdCount: '2', householdEmpty: false});
  const text = await page.evaluate(() => memoryEl.householdList.textContent);
  expect(text).toContain('Age 62');
  expect(text).toContain('prefers syrups');
  expect(text).toContain('Entered by you');
  await page.locator('#householdList .memory-forget').first().click();
  await expect.poll(() => page.evaluate(() => sections().household)).toEqual(['Kavin']);
  expect(await page.evaluate(() => sections().householdCount)).toBe('1');
});

test('a failed household load is not "no profiles"; none stored is an honest empty state', async ({ page }) => {
  api.set('a', {household: 503});
  const failed = await page.evaluate(async () => { await signInAs('a'); await householdRefresh(); return sections(); });
  expect(failed).toMatchObject({household: [], householdCount: '–', householdEmpty: false});
  expect(failed.householdStatus).toContain("Couldn't load household profiles just now.");
  api.set('b', {household: []});
  const empty = await page.evaluate(async () => { await signInAs('b'); await householdRefresh(); return sections(); });
  expect(empty).toMatchObject({household: [], householdCount: '0', householdEmpty: true, householdStatus: ''});
});

test('orders: a failed source is said, and "No orders yet." only when both answered', async ({ page }) => {
  api.set('a', {siruOrders: 503, demo: {orders: [], bookings: []}});
  const partly = await page.evaluate(async () => { await signInAs('a'); await memoryOrdersRefresh('a'); return sections(); });
  expect(partly.orders).toContain("Couldn't load your SIRU orders just now");
  expect(partly.orders).not.toContain('No orders yet.');
  api.set('b', {siruOrders: [], demo: {orders: [], bookings: []}});
  const none = await page.evaluate(async () => { await signInAs('b'); await memoryOrdersRefresh('b'); return sections(); });
  expect(none.orders).toBe('No orders yet.');
});

test("switching users never leaves the previous user's household or orders on screen", async ({ page }) => {
  api.set('a', {household: [member('m1', 'Amma')], demo: {orders: [{id: 'A-ORDER-1', status: 'CONFIRMED_DEMO',
    createdAt: '2026-10-01T10:00:00Z', items: [], totalPaise: 1000}], bookings: []}, siruOrders: []});
  await page.evaluate(async () => { await signInAs('a'); await householdRefresh(); await memoryOrdersRefresh('a'); });
  expect((await page.evaluate(() => sections())).orders).toContain('A-ORDER-1');
  // B's answers are held open: while they load, nothing of A's may show.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  api.set('b', {household: held.then(() => []), siruOrders: held.then(() => []),
    demo: held.then(() => ({orders: [], bookings: []}))});
  const during = await page.evaluate(async () => {
    await signInAs('b');
    householdRefresh(); memoryOrdersRefresh('b');
    await settle();
    return sections();
  });
  expect(during.household).toEqual([]);
  expect(during.orders).not.toContain('A-ORDER-1');
  expect(during.orders).toContain('Loading orders…');
  release();
  await expect.poll(() => page.evaluate(() => sections().orders)).toBe('No orders yet.');
});

test('signing out clears every section of the Memory tab', async ({ page }) => {
  api.set('a', {household: [member('m1', 'Amma')], siruOrders: [], demo: {orders: [{id: 'A-ORDER-1', status: 'CONFIRMED_DEMO',
    createdAt: '2026-10-01T10:00:00Z', items: [], totalPaise: 1000}], bookings: []}});
  await page.evaluate(async () => { await signInAs('a'); await householdRefresh(); await memoryOrdersRefresh('a'); });
  const after = await page.evaluate(async () => { await signOut(); await settle(); return sections(); });
  expect(after.household).toEqual([]);
  expect(after.orders).toBe('');
  expect(after.cart).toBe('Sign in to see your cart.');
  expect(after.stm).toBe(0);
});

test('a cart that could not be loaded says so - not "Loading the cart…" forever', async ({ page }) => {
  const cart = await page.evaluate(async () => {
    await signInAs('a');
    memoryCartRender(null, {failed: 'Service is temporarily unavailable. Please try again.'});
    return sections().cart;
  });
  expect(cart).toContain("Couldn't load your cart just now.");
  expect(cart).not.toContain('Loading the cart');
});
