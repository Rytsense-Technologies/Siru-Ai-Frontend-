// A product found, added, kept across a reload, checked out and confirmed -
// once - on the real API. The product is whatever the catalog really sells
// (the client database, read only - or the sandbox in CI); its price is the
// catalog's, and the cart must hold exactly that.
const { test } = require('@playwright/test');
const { env, signIn, api, say, expect } = require('./helpers.cjs');

let product = null;
let actionId = null;

async function pickProduct(page) {
  const shelf = await api(page, '/v1/pharmacy/products?nearest=true');
  expect(shelf.status).toBe(200);
  const buyable = shelf.body.filter(p => !p.prescriptionRequired && p.inStock !== false && p.pricePaise > 0
    && /^[A-Za-z0-9 .\-+]{4,40}$/.test(p.name || ''));
  expect(buyable.length, 'the catalog has a buyable OTC product').toBeGreaterThan(0);
  return buyable[0];
}

test.describe.serial('search, cart and order', () => {
  test('a product search answers from the catalog', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    await api(page, `/v1/pharmacy/cart/${(await api(page, '/v1/auth/me')).body.user_id}`, { method: 'DELETE' });
    product = await pickProduct(page);
    const { text } = await say(page, `Do you have ${product.name}?`);
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain(product.name.split(' ')[0].toLowerCase());
  });

  test('added by chat, the cart holds the catalog\'s price, and a reload keeps it', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    const me = (await api(page, '/v1/auth/me')).body.user_id;
    await say(page, `add ${product.name} to my cart`);
    const cart = await api(page, `/v1/pharmacy/cart/${me}`);
    expect(cart.status).toBe(200);
    const line = cart.body.items.find(i => i.name === product.name || i.item_id === product.id);
    expect(line, JSON.stringify(cart.body)).toBeTruthy();
    expect(line.unit_price_paise).toBe(product.pricePaise);  // the catalog's, not anyone's guess
    await page.reload();
    await expect(page.locator('#cartCount')).not.toHaveText('0');
  });

  test('checkout prepares, Confirm places it once, and a second confirm changes nothing', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    const me = (await api(page, '/v1/auth/me')).body.user_id;
    const ordersBefore = (await api(page, '/v1/actions/demo')).body;
    await say(page, 'place my order');
    const card = page.locator('.confirm-card[data-action-id]').last();
    await expect(card).toBeVisible();
    actionId = await card.getAttribute('data-action-id');
    await card.getByRole('button', { name: 'Confirm' }).click();
    await expect(card.locator('.card-note')).not.toHaveText(/Nothing is done until you tap Confirm/, { timeout: 60_000 });
    const again = await api(page, `/v1/actions/${actionId}/confirm`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const ordersAfter = (await api(page, '/v1/actions/demo')).body;
    const count = body => (Array.isArray(body) ? body : body?.orders || []).length;
    expect(count(ordersAfter)).toBe(count(ordersBefore) + 1);
    const cart = await api(page, `/v1/pharmacy/cart/${me}`);
    expect(cart.body.items).toEqual([]);
  });

  test('another user cannot confirm or read that order', async ({ browser }) => {
    const [, b] = env().accounts;
    const page = await (await browser.newContext()).newPage();
    await signIn(page, b);
    const stolen = await api(page, `/v1/actions/${actionId}/confirm`, { method: 'POST' });
    expect(stolen.status).toBe(404);
    const theirs = (await api(page, '/v1/actions/demo')).body;
    expect(JSON.stringify(theirs)).not.toContain(actionId.slice(0, 8).toUpperCase());
  });
});
