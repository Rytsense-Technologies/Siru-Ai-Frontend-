// The customer's own records on the real API (12 Oct audit) - each compared with what the server stored:
//  * an order placed, then "show my last order", the My orders dialog (its time is the real one - the sandbox
//    used to show 19:00 IST as 00:30 the next day) and "reorder my last order" (the cart, on the server);
//  * a family member's condition and allergy said in one breath - both on her profile (the allergy used to be
//    dropped), then an add of what she is allergic to is not made for her without a warning;
//  * a refill reminder asked for in chat - a schedule on the server, shown under Memory;
//  * an emergency - the emergency reply, never a product.
// Deterministic answers only (no model call): with the local model key invalid they still run, as they would.
const { test } = require('@playwright/test');
const { env, signIn, setLocation, place, api, say, meId, stackMode, expect } = require('./helpers.cjs');

async function buyable(page) {
  const { latitude, longitude } = place();
  const shelf = (await api(page, `/v1/pharmacy/products?nearest=true&lat=${latitude}&lng=${longitude}`)).body;
  const found = shelf.find(p => !p.prescriptionRequired && p.inStock !== false && p.pricePaise > 0 && p.deliversHere === true
    && /^[A-Za-z0-9 .\-+]{4,40}$/.test(p.name || ''));
  expect(found, 'the catalog has a buyable OTC product').toBeTruthy();
  return found;
}

test.describe.serial('the customer\'s own records', () => {
  test('an order: last order, the My orders dialog at its real time, and reorder into the cart', async ({ page }) => {
    test.skip(await stackMode() !== 'sandbox', 'places an order: the local sandbox only, never the client database');
    test.setTimeout(180_000);
    const [a] = env().accounts;
    await signIn(page, a);
    await setLocation(page);
    const me = await meId(page);
    await api(page, `/v1/pharmacy/cart/${me}`, { method: 'DELETE' });
    const product = await buyable(page);
    let added = await say(page, `add ${product.name} to my cart`);
    if (/select the pharmacy/i.test(added.text)) {
      await say(page, 'Use the first pharmacy');
      added = await say(page, `add ${product.name} to my cart`);
    }
    const placedAt = Date.now();
    const { text } = await say(page, 'place my order');
    const number = (text.match(/order\s+(\S+)\s+has been placed/i) || [])[1];
    expect(number, text).toBeTruthy();

    // What the server holds, and what the page says about it.
    const orders = (await api(page, `/v1/pharmacy/orders/${me}`)).body;
    const list = Array.isArray(orders) ? orders : orders.orders || [];
    const stored = list.find(o => (o.orderNumber || o.number) === number);
    expect(stored, JSON.stringify(list).slice(0, 300)).toBeTruthy();
    expect(Math.abs(new Date(stored.createdAt).getTime() - placedAt)).toBeLessThan(5 * 60_000);   // its real time
    expect((await say(page, 'show my last order')).text).toContain(number);

    await page.click('#ordersBtn');
    const dialog = page.locator('#ordersDialog');
    await expect(dialog).toContainText(number);
    const shown = await page.evaluate(at => new Date(at).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}),
      stored.createdAt);
    await expect(dialog).toContainText(shown);
    await page.keyboard.press('Escape');

    const reorder = await say(page, 'reorder my last order');
    expect(reorder.text).toContain(number);
    const cart = (await api(page, `/v1/pharmacy/cart/${me}`)).body;
    expect(cart.items.map(i => i.name)).toContain(product.name);
    await expect(page.locator('#cartCount')).toHaveText(String(cart.items.reduce((n, i) => n + i.qty, 0)));
  });

  test('a member\'s condition and allergy said together are both kept on her profile', async ({ page }) => {
    test.setTimeout(120_000);
    const [, b] = env().accounts;
    await signIn(page, b);
    const { text } = await say(page, 'My mother is diabetic and allergic to penicillin');
    expect(text).toContain('diabetes');
    expect(text).toContain('penicillin');
    const { members } = (await api(page, '/v1/household/me')).body;
    const mother = members.find(m => m.relationship === 'mother');
    expect(mother, JSON.stringify(members)).toBeTruthy();
    expect(mother.health_notes.map(n => `${n.kind}:${n.value}`).sort()).toEqual(['allergy:penicillin', 'condition:diabetes']);
    await page.click('#memoryBtn');
    await expect(page.locator('#householdList')).toContainText('penicillin');
    await expect(page.locator('#householdList')).toContainText('diabetes');
  });

  test('a refill reminder asked for in chat is a schedule on the server, shown under Memory', async ({ page }) => {
    test.setTimeout(120_000);
    const [, b] = env().accounts;
    await signIn(page, b);
    const { text } = await say(page, 'Remind me to refill Dolo 650 every month');
    const { schedules } = (await api(page, '/v1/refill-schedules/me')).body;
    const kept = schedules.find(s => /dolo 650/i.test(s.medicine));
    expect(kept, JSON.stringify(schedules).slice(0, 300)).toBeTruthy();
    expect(kept.interval).toEqual({ every: 1, unit: 'month' });
    expect(text).toContain(kept.estimate.next_refill_date);         // said as set only with the stored date
    await page.click('#memoryBtn');
    await expect(page.locator('#schedList')).toContainText('Dolo 650');
    await expect(page.locator('#schedList')).toContainText('Every month');
  });

  test('an emergency is the emergency reply', async ({ page }) => {
    const [, b] = env().accounts;
    await signIn(page, b);
    const { text } = await say(page, 'I have severe chest pain and I cannot breathe');
    expect(text).toMatch(/emergency/i);
    expect(text).toContain('108');
  });
});
