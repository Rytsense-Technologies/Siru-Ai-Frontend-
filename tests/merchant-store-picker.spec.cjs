// sec-88: a store owner with several stores saw "Several stores - choose one in the SIRU app." on every
// panel and had nowhere to choose. Now the page lists the owner's own stores (GET /v1/merchant/me/stores)
// and, with several, shows a picker in the page head; the chosen store goes with every figure read
// (?store_id=) and every assistant question (store_id) - the API checks it is the owner's own. A one-store
// owner gets no picker and the same requests as before. The page's own code runs; only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'};
const STORES = {
  two: [{id: 's1', name: 'Anna Nagar Pharmacy', isOpen: true}, {id: 's2', name: 'Adyar Pharmacy', isOpen: true}],
  one: [{id: 's1', name: 'Anna Nagar Pharmacy', isOpen: true}],
};

async function openAsMerchant(page, stores) {
  const seen = {reads: [], asks: []};
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/auth/me') return route.fulfill({headers: cors, json: {id: 'merchant-m-1', name: 'Owner', role: 'merchant'}});
    if (path === '/v1/merchant/me/stores') return route.fulfill({headers: cors, json: {stores}});
    if (path.startsWith('/v1/merchant/')) {
      const storeId = url.searchParams.get('store_id');
      seen.reads.push(`${path.split('/').pop()}:${storeId || ''}`);
      const store = stores.find(s => s.id === storeId) || (stores.length === 1 ? stores[0] : null);
      if (!store) {
        return route.fulfill({status: 409, headers: cors, json: {detail: {code: 'several_stores',
          message: 'This merchant account has more than one store - choose a store at the top of the page.'}}});
      }
      const data = path.endsWith('/dashboard')
        ? {store: {name: store.name, category: 'pharmacy', status: 'OPEN', isOpen: true},
           today: {revenuePaise: 0, orders: 0}, week: {revenuePaise: 0, orders: 0}}
        : {items: [], meta: {total: 0}};
      return route.fulfill({headers: cors, json: {section: path.split('/').pop(), tool: null, data}});
    }
    if (path === '/v1/agents/run') {
      seen.asks.push(request.postDataJSON());
      return route.fulfill({headers: cors, json: {request_id: 'r', final_output: 'ok', hop_count: 1, history: [], cards: []}});
    }
    return route.fulfill({headers: cors, json: {}});
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token-m', expires_at: Date.now() / 1000 + 3600,
              user: {id: 'merchant-m-1', role: 'merchant', name: 'Owner'}});
    await applySignedInUser();
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  });
  return seen;
}

test('an owner of several stores chooses one, and every read and question is for it', async ({ page }) => {
  const seen = await openAsMerchant(page, STORES.two);
  const picker = page.locator('#merchantStorePicker select');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveText(['Choose a store…', 'Anna Nagar Pharmacy', 'Adyar Pharmacy']);
  await expect(page.locator('#merchantNotice')).toContainText('choose a store at the top of the page');

  await picker.selectOption('s2');
  await expect(page.locator('#merchantTitle')).toHaveText('Adyar Pharmacy');
  // The panels load after the title: waited for, not counted at once (it flaked at 1 or 3 of them).
  await expect.poll(() => seen.reads.filter(r => r.startsWith('dashboard:'))).toContain('dashboard:s2');
  await expect.poll(() => seen.reads.filter(r => r.endsWith(':s2')).length).toBeGreaterThan(3);  // every panel, for that store

  await page.evaluate(() => merchantAsk('how are sales today'));
  expect(seen.asks.at(-1)).toMatchObject({user_input: 'how are sales today', store_id: 's2'});
});

test('the choice is kept for the tab and cleared when someone else signs in', async ({ page }) => {
  await openAsMerchant(page, STORES.two);
  await page.locator('#merchantStorePicker select').selectOption('s1');
  await expect(page.locator('#merchantTitle')).toHaveText('Anna Nagar Pharmacy');
  await page.reload();
  await page.waitForLoadState('load');
  await expect(page.locator('#merchantStorePicker select')).toHaveValue('s1');
  await page.evaluate(async () => { authSave(null); await applySignedInUser(); });
  await expect(page.locator('#merchantStorePicker')).toHaveCount(0);
});

test('an owner of one store gets no picker and the requests are as before', async ({ page }) => {
  const seen = await openAsMerchant(page, STORES.one);
  await expect(page.locator('#merchantTitle')).toHaveText('Anna Nagar Pharmacy');
  await expect(page.locator('#merchantStorePicker')).toHaveCount(0);
  expect(seen.reads.every(r => r.endsWith(':'))).toBe(true);  // no store_id sent
  await page.evaluate(() => merchantAsk('how are sales today'));
  expect(seen.asks.at(-1).store_id).toBeUndefined();
});
