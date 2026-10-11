// The shop page's pharmacy pick, on the real API: picked in the pharmacy dialog, it is the server's choice for
// this chat (POST /v1/pharmacy/selection) - the chat's next add comes from that pharmacy without asking which,
// and the cart is that pharmacy's. Another user can't make or read that choice for A.
const { test } = require('@playwright/test');
const { env, signIn, setLocation, api, say, meId, expect } = require('./helpers.cjs');

test.describe.serial('the shop page\'s pharmacy pick', () => {
  test('a pharmacy picked on the shop page is the one the chat adds from', async ({ page }) => {
    const [a] = env().accounts;
    await signIn(page, a);
    await setLocation(page);
    const me = await meId(page);
    await api(page, `/v1/pharmacy/cart/${me}`, { method: 'DELETE' });
    await page.locator('#shopNearbyBtn').click();
    const picked = page.waitForResponse(r => /\/v1\/pharmacy\/selection\//.test(r.url()) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Select' }).first().click();
    const response = await picked;
    expect(response.status()).toBe(200);
    const store = (await response.json()).selected;
    expect(store?.storeId, 'the server recorded the pick').toBeTruthy();
    // An over-the-counter medicine that pharmacy has in stock, from its own shelf.
    const shelf = (await api(page, `/v1/pharmacy/products?store_id=${encodeURIComponent(store.storeId)}`)).body;
    const product = shelf.find(p => !p.prescriptionRequired && p.inStock !== false && p.pricePaise > 0
      && /^[A-Za-z0-9 .\-+]{4,40}$/.test(p.name || ''));
    expect(product, 'the picked pharmacy sells an OTC product').toBeTruthy();
    await page.keyboard.press('Escape');  // the pharmacy dialog
    const { text } = await say(page, `add ${product.name} to my cart`);
    expect(text).not.toMatch(/select the pharmacy/i);   // no second "which pharmacy?" - it was picked
    const cart = (await api(page, `/v1/pharmacy/cart/${me}`)).body;
    expect(cart.storeId).toBe(store.storeId);
    expect(cart.items.find(i => i.name === product.name)?.unit_price_paise).toBe(product.pricePaise);
  });

  test('another user cannot pick a pharmacy for A', async ({ browser }) => {
    const [a, b] = env().accounts;
    const pageA = await (await browser.newContext()).newPage();
    await signIn(pageA, a);
    const meA = await meId(pageA);
    const pageB = await (await browser.newContext()).newPage();
    await signIn(pageB, b);
    const forged = await api(pageB, `/v1/pharmacy/selection/${meA}`, {
      method: 'POST', body: JSON.stringify({ store_id: 'any-store', session_id: 'any-session' }),
    });
    expect([403, 404]).toContain(forged.status);
    const unknown = await api(pageA, `/v1/pharmacy/selection/${meA}`, {
      method: 'POST', body: JSON.stringify({ store_id: 'no-such-pharmacy', session_id: 'any-session' }),
    });
    expect(unknown.status).toBe(404);   // never chosen by a name or id the page made up
  });
});
