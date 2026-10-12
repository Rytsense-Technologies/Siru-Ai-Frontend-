// The customer top bar's chips - location, Nearby, Cart, Orders - on phones (12 Oct audit): they sat on one
// line that scrolled sideways with its scrollbar hidden, so "Orders" was cut off at the screen's edge with
// nothing to say there was more. Every chip is now whole and on screen at 375 and 390 px - none hidden,
// none scrolled away - and the page never scrolls sideways; on a desktop they stay on the bar's one line.
// The page's own code runs; only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'};
const CHIPS = ['#locationRow', '#shopNearbyBtn', '#cartBtn', '#ordersBtn'];

async function signedInBuyer(page, width, height) {
  await page.setViewportSize({width, height});
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), p = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (p === '/v1/auth/me') return route.fulfill({headers: cors, json: {id: 'buyer-1', name: 'Test Buyer', role: 'buyer'}});
    if (p === '/v1/pharmacy/stores/nearby') return route.fulfill({headers: cors, json: {stores: []}});
    if (p === '/v1/pharmacy/products') return route.fulfill({headers: cors, json: []});
    if (/^\/v1\/pharmacy\/cart\/[^/]+$/.test(p)) return route.fulfill({headers: cors, json: {items: [], storeId: null}});
    return route.fulfill({status: 404, headers: cors, json: {detail: 'Not Found'}});
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token-b', expires_at: Date.now() / 1000 + 3600, user: {id: 'buyer-1', role: 'buyer', name: 'Test Buyer'}});
    await applySignedInUser();
  });
  // The first sign-in asks for a location (location-ui.js locationStart, after an async permission check): waited
  // for, then set the page's own way - with a long address, the widest the location chip gets.
  await expect(page.locator('#locationDialog')).toBeVisible({timeout: 15000});
  await page.evaluate(() => {
    locationSave({source: 'manual', address: 'Flat 4B, Sri Lakshmi Apartments, Velachery Main Road, Chennai',
                  pincode: '600042', lat: 12.98, lng: 80.22});
    document.getElementById('locationDialog').close();
  });
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  // Orders shows once the user has any order history; shown here so all four are measured.
  await page.evaluate(() => { document.getElementById('ordersBtn').hidden = false; });
  await expect(page.locator('#contextRow')).toBeVisible();
}

const boxes = page => page.evaluate(chips => ({
  viewport: window.innerWidth,
  pageScrolls: document.documentElement.scrollWidth > window.innerWidth,
  rowScrolls: (() => { const row = document.getElementById('contextRow'); return row.scrollWidth > row.clientWidth + 1; })(),
  chips: chips.map(sel => {
    const el = document.querySelector(sel), r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return {sel, left: r.left, right: r.right, top: r.top, height: r.height, shown: s.display !== 'none' && s.visibility !== 'hidden'};
  }),
}), CHIPS);

for (const width of [375, 390]) {
  test(`at ${width} px every header chip is whole and on screen, and nothing scrolls sideways`, async ({ page }) => {
    await signedInBuyer(page, width, 800);
    const m = await boxes(page);
    expect(m.pageScrolls, 'the page scrolls sideways').toBe(false);
    expect(m.rowScrolls, 'the chip row hides chips behind a sideways scroll').toBe(false);
    for (const chip of m.chips) {
      expect(chip.shown, `${chip.sel} is hidden`).toBe(true);
      expect(chip.left, `${chip.sel} starts off screen`).toBeGreaterThanOrEqual(0);
      expect(chip.right, `${chip.sel} is cut off at the right edge`).toBeLessThanOrEqual(m.viewport);
    }
    // Each one works where it is: a real tap target, and a click reaches it (nothing on top of it).
    for (const sel of ['#shopNearbyBtn', '#cartBtn', '#ordersBtn']) {
      const box = m.chips.find(c => c.sel === sel);
      expect(box.height, `${sel} is too small to tap`).toBeGreaterThanOrEqual(32);
      await page.locator(sel).click({trial: true});
    }
  });
}

test('on a desktop the chips stay on the top bar\'s one line', async ({ page }) => {
  await signedInBuyer(page, 1366, 860);
  const m = await boxes(page);
  expect(m.pageScrolls).toBe(false);
  const tops = new Set(m.chips.map(c => Math.round(c.top)));
  expect(tops.size, JSON.stringify(m.chips)).toBe(1);
  for (const chip of m.chips) expect(chip.right).toBeLessThanOrEqual(m.viewport);
});

// The chat header on phones (12 Oct audit: 117 px over three lines at 375 px - "Ready" or "Memory" alone on the
// last - with 26 px buttons): the status beside the title, New chat / Tool calls / Memory on one line as 32 px
// tap targets, each with its words and count. A desktop keeps them all on the title's line.
const chatHeader = page => page.evaluate(() => {
  const box = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return {top: Math.round(r.top), bottom: Math.round(r.bottom), left: r.left, right: r.right, height: r.height}; };
  const card = document.querySelector('.chat-heading').getBoundingClientRect();
  return {title: box('.chat-heading h2'), status: box('#chatStatus'), card: {left: card.left, right: card.right},
    buttons: ['#newChatBtn', '#activityBtn', '#memoryBtn'].map(sel => ({sel, ...box(sel), text: document.querySelector(sel).innerText.replace(/\s+/g, ' ').trim()})),
    address: (() => { const el = document.querySelector('#locationRowLine'); return el && getComputedStyle(el).display !== 'none' ? el.textContent : null; })()};
});

for (const width of [375, 390]) {
  test(`at ${width} px the chat header is two lines: title with status, then the three buttons`, async ({ page }) => {
    await signedInBuyer(page, width, 800);
    const h = await chatHeader(page);
    expect(new Set(h.buttons.map(b => b.top)).size, JSON.stringify(h.buttons)).toBe(1);        // one line
    expect(h.status.top).toBeLessThan(h.buttons[0].top);                                       // above them, by the title
    expect(h.status.bottom).toBeGreaterThan(h.title.top);
    for (const b of h.buttons) {
      expect(b.height, `${b.sel} is too small to tap`).toBeGreaterThanOrEqual(32);
      expect(b.left).toBeGreaterThanOrEqual(h.card.left);
      expect(b.right).toBeLessThanOrEqual(h.card.right + 0.5);
    }
    // Words and counts kept ("–": the count not known - here the stand-in API has no memory route).
    const [newChat, tools, memory] = h.buttons.map(b => b.text);
    expect(newChat).toBe('New chat');
    expect(tools).toMatch(/^Tool calls (\d+|–)$/);
    expect(memory).toMatch(/^Memory (\d+|–)$/);
    expect(h.address, 'the address is shown beside "Address"').toBeTruthy();
  });
}

test('on a desktop the chat header stays one line', async ({ page }) => {
  await signedInBuyer(page, 1366, 860);
  const h = await chatHeader(page);
  for (const b of [...h.buttons, h.status]) expect(Math.abs(b.top - h.buttons[0].top)).toBeLessThanOrEqual(6);
});
