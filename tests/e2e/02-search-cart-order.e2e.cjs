// A product found, added, kept across a reload, checked out and confirmed -
// once - on the real API. The product is whatever the catalog really sells
// (the client database, read only - or the sandbox in CI); its price is the
// catalog's, and the cart must hold exactly that.
//
// Preconditions a real user meets too: a delivery location is set (an add without one is asked for one -
// nothing added), and a pharmacy is chosen when the app asks which (setLocation, choosePharmacyIfAsked).
// The order step follows the stack's mode: with the client's data (read only) an order is prepared and placed
// on the Confirm tap; on the local sandbox a typed order is placed at once (actions/service.py prepares_writes).
const { test } = require('@playwright/test');
const { env, signIn, setLocation, place, stackMode, api, say, meId, expect } = require('./helpers.cjs');

let product = null;
let actionId = null;
let orderNumber = null;

async function pickProduct(page) {
  const { latitude, longitude } = place();
  const shelf = await api(page, `/v1/pharmacy/products?nearest=true&lat=${latitude}&lng=${longitude}`);
  expect(shelf.status).toBe(200);
  // Sold by a pharmacy known to deliver to this location - one a user here can actually add (a store whose
  // delivery is unknown, or a grocery shelf, isn't one the pharmacy chat shops from).
  const buyable = shelf.body.filter(p => !p.prescriptionRequired && p.inStock !== false && p.pricePaise > 0
    && p.deliversHere === true && /^[A-Za-z0-9 .\-+]{4,40}$/.test(p.name || ''));
  expect(buyable.length, 'the catalog has a buyable OTC product').toBeGreaterThan(0);
  return buyable[0];
}

// "Select the pharmacy": the first one listed, as a user would tap it - then the add again, from it.
async function addToCart(page, name) {
  const { text } = await say(page, `add ${name} to my cart`);
  if (/select the pharmacy/i.test(text)) {
    await say(page, 'Use the first pharmacy');
    return say(page, `add ${name} to my cart`);
  }
  return { text };
}

test.describe.serial('search, cart and order', () => {
  test('a product search answers from the catalog', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    await setLocation(page);
    await api(page, `/v1/pharmacy/cart/${await meId(page)}`, { method: 'DELETE' });
    product = await pickProduct(page);
    const { text } = await say(page, `Do you have ${product.name}?`);
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain(product.name.split(' ')[0].toLowerCase());
  });

  test('added by chat, the cart holds the catalog\'s price, and a reload keeps it', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    await setLocation(page);
    const me = await meId(page);
    await addToCart(page, product.name);
    const cart = await api(page, `/v1/pharmacy/cart/${me}`);
    expect(cart.status).toBe(200);
    const line = cart.body.items.find(i => i.name === product.name);
    expect(line, JSON.stringify(cart.body)).toBeTruthy();
    // The catalog's price at the cart's own pharmacy - not anyone's guess, and not another pharmacy's.
    const shelf = await api(page, `/v1/pharmacy/products?store_id=${encodeURIComponent(cart.body.storeId)}`);
    const listed = shelf.body.find(p => p.id === line.item_id);
    expect(listed, 'the cart line is that pharmacy\'s own listing').toBeTruthy();
    expect(line.unit_price_paise).toBe(listed.pricePaise);
    await page.reload();
    await expect(page.locator('#cartCount')).not.toHaveText('0');
  });

  test('checkout prepares, Confirm places it once, and a second confirm changes nothing', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    await setLocation(page);
    const me = await meId(page);
    if (await stackMode() === 'sandbox') {
      // The sandbox places a typed order at once: once, from the cart, and the cart is then empty.
      const before = (await api(page, `/v1/pharmacy/orders/${me}`)).body;
      const { text } = await say(page, 'place my order');
      expect(text).toMatch(/has been placed/);
      orderNumber = (text.match(/order\s+(\S+)\s+has been placed/i) || [])[1] || null;
      const after = (await api(page, `/v1/pharmacy/orders/${me}`)).body;
      expect(after.length).toBe(before.length + 1);
      expect((await api(page, `/v1/pharmacy/cart/${me}`)).body.items).toEqual([]);
      const again = await say(page, 'place my order');   // nothing left to order: never a second order
      expect(again.text).not.toMatch(/has been placed/);
      expect((await api(page, `/v1/pharmacy/orders/${me}`)).body.length).toBe(after.length);
      return;
    }
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
    const [a, b] = env().accounts;
    const page = await (await browser.newContext()).newPage();
    await signIn(page, b);
    if (await stackMode() === 'sandbox') {
      // A's orders, asked for by B: refused by the server - and B's own list has none of A's.
      const owner = await (async () => {
        const other = await (await browser.newContext()).newPage();
        await signIn(other, a);
        return await meId(other);
      })();
      const stolen = await api(page, `/v1/pharmacy/orders/${owner}`);
      expect([403, 404]).toContain(stolen.status);
      const mine = (await api(page, `/v1/pharmacy/orders/${await meId(page)}`)).body;
      if (orderNumber) expect(JSON.stringify(mine)).not.toContain(orderNumber);
      return;
    }
    const stolen = await api(page, `/v1/actions/${actionId}/confirm`, { method: 'POST' });
    expect(stolen.status).toBe(404);
    const theirs = (await api(page, '/v1/actions/demo')).body;
    expect(JSON.stringify(theirs)).not.toContain(actionId.slice(0, 8).toUpperCase());
  });
});
