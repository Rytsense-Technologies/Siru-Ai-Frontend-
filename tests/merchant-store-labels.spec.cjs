// sec-89: the store-owner pages labelled one store's figures with another store's name. The name beside
// the figures was the last one the overview's dashboard read returned (merchantStoreName) - choosing
// another store on any other page (Top items, Orders...) left the sidebar naming the store chosen before,
// over the new store's figures; and the assistant went on with the earlier store's conversation, so its
// next answer had the other store's turns as context. Now choosing a store names it at once, from the
// owner's own list, everywhere the page names the store, and the assistant starts that store's own
// conversation. The page's own code runs; only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'};
const STORES = [{id: 's1', name: 'Anna Nagar Pharmacy', isOpen: true}, {id: 's2', name: 'Adyar Pharmacy', isOpen: true}];

async function openAsOwnerOfTwo(page) {
  const asks = [];
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/auth/me') return route.fulfill({headers: cors, json: {id: 'merchant-m-1', name: 'Owner', role: 'merchant'}});
    if (path === '/v1/merchant/me/stores') return route.fulfill({headers: cors, json: {stores: STORES}});
    if (path.startsWith('/v1/merchant/')) {
      const store = STORES.find(s => s.id === url.searchParams.get('store_id'));
      if (!store) return route.fulfill({status: 409, headers: cors, json: {detail: {code: 'several_stores', message: 'choose a store'}}});
      const data = path.endsWith('/dashboard')
        ? {store: {name: store.name, category: 'pharmacy', status: 'OPEN', isOpen: true}, today: {}, week: {}}
        : {items: [{name: `${store.name} best seller`, unitsSold: 3}], meta: {total: 1}};
      return route.fulfill({headers: cors, json: {section: path.split('/').pop(), tool: null, data}});
    }
    if (path === '/v1/agents/run') {
      asks.push(request.postDataJSON());
      return route.fulfill({headers: cors, json: {request_id: 'r', final_output: 'ok', hop_count: 1, history: [], cards: []}});
    }
    return route.fulfill({headers: cors, json: {}});
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token-m', expires_at: Date.now() / 1000 + 3600, user: {id: 'merchant-m-1', role: 'merchant', name: 'Owner'}});
    await applySignedInUser();
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  });
  await expect(page.locator('#merchantStorePicker select')).toBeVisible();
  return asks;
}

test('choosing another store on a page other than the overview names that store, not the one before', async ({ page }) => {
  await openAsOwnerOfTwo(page);
  const picker = page.locator('#merchantStorePicker select');
  await picker.selectOption('s1');
  await expect(page.locator('#merchantName')).toHaveText('Anna Nagar Pharmacy');
  await page.evaluate(() => merchantShow('top-items'));
  await picker.selectOption('s2');
  await expect(page.locator('#merchantBody')).toContainText('Adyar Pharmacy best seller');
  await expect(page.locator('#merchantName')).toHaveText('Adyar Pharmacy');  // never "Anna Nagar" over Adyar's figures
});

test('the assistant starts the chosen store\'s own conversation - no other store\'s turns as context', async ({ page }) => {
  const asks = await openAsOwnerOfTwo(page);
  const picker = page.locator('#merchantStorePicker select');
  await picker.selectOption('s1');
  await page.evaluate(() => merchantAsk('top sellers this week'));
  const first = asks.at(-1);
  expect(first).toMatchObject({store_id: 's1', history: []});
  await expect(page.locator('#merchantLog')).not.toBeEmpty();
  await picker.selectOption('s2');
  await expect(page.locator('#merchantLog')).toBeEmpty();         // Anna Nagar's answers are not shown under Adyar
  await page.evaluate(() => merchantAsk('top sellers this week'));
  const second = asks.at(-1);
  expect(second.store_id).toBe('s2');
  expect(second.history).toEqual([]);                          // nothing said about Anna Nagar
  expect(second.conversation_id).not.toBe(first.conversation_id);
});
