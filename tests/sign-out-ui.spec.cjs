// sec-2 through the page's own controls: A signs in with the sign-in form,
// types a question and presses Send, or adds a medicine in the Nearby
// pharmacies dialog - then signs out from the user menu while the answer is
// still on its way. Nothing is called in-page: the page's own fetch code runs
// and only the network is stood in for (page.route), with A's answer held
// until the test releases it - after A left, or after B signed in.
// No model, pharmacy, booking or payment service is reached.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const A = 'patient-a@example.test', B = 'patient-b@example.test';
const A_QUESTION = 'Patient A asks about heart medication';
const A_REPLY = 'Patient A reply about heart medication';
const A_PRODUCT = 'Dolo 650 for Patient A';
const A_PHARMACY = 'Patient A Pharmacy';
const A_ERROR = `${A_PRODUCT} is out of stock at ${A_PHARMACY}`;
const ACTIVE_KEYS = /^siru_(chat|sessions|current_session)_/;

test.use({ geolocation: { latitude: 13.0418, longitude: 80.2341 }, permissions: ['geolocation'] });

let held, problems;  // responses held open, by name; console errors and page errors

test.beforeEach(async ({ page }) => {
  held = new Map();
  problems = [];
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  // The browser's own "Failed to load resource" line for a stand-in 404 (an
  // endpoint these tests don't need) or the 400/409 a test sends is not one.
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console: ${message.text()}`);
  });
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'};
  const hold = name => new Promise(release => held.set(name, release));
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({status, headers: cors, json: body});
    if (method === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (p === '/v1/auth/login') {
      const {email} = request.postDataJSON();
      return json({access_token: `token-${email}`, expires_at: Date.now() / 1000 + 3600, user: {id: email, role: 'buyer', name: email}});
    }
    if (p === '/v1/auth/logout') return route.fulfill({status: 204, headers: cors});
    if (p === '/v1/pharmacy/stores/nearby') {
      return json({stores: [{id: 'store-a', name: A_PHARMACY, distanceKm: 1.2, etaMin: 20, area: 'Test Area'}]});
    }
    if (p === '/v1/pharmacy/products') {
      return json([{id: 'dolo-650', name: A_PRODUCT, unit: '15 tablets', pricePaise: 3000, storeId: 'store-a',
        storeName: A_PHARMACY, inStock: true, prescriptionRequired: false}]);
    }
    if (/^\/v1\/pharmacy\/cart\/[^/]+\/items$/.test(p) && method === 'POST') {
      const answer = await hold('cart-add');  // A's add: answered when the test says, as it says
      return json(answer.body, answer.status);
    }
    if (/^\/v1\/pharmacy\/cart\/[^/]+\/bill$/.test(p)) return json({detail: 'Not Found'}, 404);
    if (/^\/v1\/pharmacy\/cart\/[^/]+$/.test(p)) return json({items: [], storeId: null});
    if (p === '/v1/concierge/turn') {
      await hold('turn');  // A's typed turn: the answer arrives when the test releases it
      const events = [{type: 'text', text: A_REPLY}, {type: 'turn_end', trace: {agent: 'care_agent', steps: []}, trace_id: 't-a'},
        {type: 'done'}];
      return route.fulfill({status: 200, headers: {...cors, 'Content-Type': 'text/event-stream'},
        body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')});
    }
    if (p === '/v1/memory/me') return json({facts: []});
    return json({detail: 'Not Found'}, 404);
  });
  await page.goto('/index.html');
});

async function signIn(page, email) {
  await page.locator('#loginEmail').fill(email);
  await page.locator('#loginPassword').fill('test-password');
  await page.locator('#loginBtn').click();
  await expect(page.locator('#currentUserName')).toHaveText(email);  // the menu shows who is signed in
  // A first sign-in may ask about location: a person closes it.
  for (const dialog of await page.locator('dialog[open]').all()) await dialog.press('Escape');
}

async function signOutFromMenu(page) {
  await page.locator('#userMenu > summary').click();
  await page.locator('#logoutBtn').click();
  await expect(page.locator('#loginView')).toBeVisible();
}

// The keys and values this device holds, read as the test's evidence.
const device = page => page.evaluate(() => [localStorage, sessionStorage].flatMap(storage =>
  Object.keys(storage).map(key => ({key, value: storage.getItem(key)}))));

function expectNothingOfA(entries, where) {
  const text = entries.map(({key, value}) => `${key}=${value}`).join('\n');
  for (const secret of [A_QUESTION, A_REPLY, A_PRODUCT, A_PHARMACY, A]) expect(text, where).not.toContain(secret);
  expect(entries.map(e => e.key).filter(key => ACTIVE_KEYS.test(key) && key.includes('patient-a')), where).toEqual([]);
}

test('the page under test is the current code on disk, not a cached copy', async ({ page }) => {
  for (const file of ['users.js', 'shopping.js', 'shop-flow.js', 'user-menu.js', 'index.html']) {
    const served = await page.evaluate(async name => {
      const tag = document.querySelector(`script[src^="${name}"]`)?.getAttribute('src') || name;
      return (await fetch(tag, {cache: 'no-store'})).text();
    }, file);
    const disk = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const hash = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
    expect(hash(served), file).toBe(hash(disk));
  }
});

for (const releaseWhen of ['after A signed out', 'after B signed in']) {
  test(`A's typed answer arriving ${releaseWhen} recreates nothing of A, and B starts with an empty chat`, async ({ page }) => {
    await signIn(page, A);
    await page.locator('#askInput').fill(A_QUESTION);
    await page.getByRole('button', {name: 'Send'}).click();
    await expect.poll(() => held.has('turn')).toBe(true);  // A's answer is on its way
    await expect(page.locator('#chatMessages')).toContainText(A_QUESTION);
    await signOutFromMenu(page);
    expectNothingOfA(await device(page), 'at sign-out');
    if (releaseWhen === 'after B signed in') await signIn(page, B);
    held.get('turn')();  // A's answer arrives
    await page.waitForResponse(r => r.url().endsWith('/v1/concierge/turn'));
    await page.waitForTimeout(300);
    expectNothingOfA(await device(page), 'after the late answer');
    if (releaseWhen === 'after A signed out') await signIn(page, B);
    const chat = page.locator('#chatMessages');
    await expect(chat).not.toContainText(A_QUESTION);
    await expect(chat).not.toContainText(A_REPLY);
    // B's chat: no message of anyone's - B has asked nothing.
    await expect(chat.locator('.chat-bubble.user')).toHaveCount(0);
    expectNothingOfA(await device(page), 'with B signed in');
    expect(problems).toEqual([]);
  });
}

const CART_ANSWERS = {
  'HTTP 400 naming the product and pharmacy': {status: 400, body: {detail: A_ERROR}},
  'HTTP 409 another pharmacy\'s cart': {status: 409, body: {detail: {conflict: 'cart_store', message: `Your cart is from ${A_PHARMACY}`}}},
};
for (const [name, answer] of Object.entries(CART_ANSWERS)) {
  test(`A's medicine add answered ${name} after B signed in shows B nothing of it`, async ({ page }) => {
    await signIn(page, A);
    await page.locator('#shopNearbyBtn').click();
    await page.getByRole('button', {name: 'Select'}).click();
    await expect(page.locator('#shopBody')).toContainText(A_PRODUCT);
    await page.getByRole('button', {name: 'Add', exact: true}).click();
    await expect.poll(() => held.has('cart-add')).toBe(true);  // A's add is on its way
    await page.keyboard.press('Escape');  // closes the pharmacy dialog
    await signOutFromMenu(page);
    await signIn(page, B);
    held.get('cart-add')(answer);  // A's add is refused - now, with B signed in
    await page.waitForResponse(r => r.url().includes('/items') && r.request().method() === 'POST');
    await page.waitForTimeout(300);
    const screen = await page.locator('body').innerText();
    for (const secret of [A_ERROR, A_PRODUCT, A_PHARMACY, 'Switch pharmacy', 'another pharmacy']) {
      expect(screen, 'on screen').not.toContain(secret);
    }
    expectNothingOfA(await device(page), 'with B signed in');
    // The pharmacy dialog's content, open or not (B opens it next): nothing of
    // A's add, and no "switch pharmacy?" waiting for B to answer about A's medicine.
    const dialog = await page.locator('#shopBody').evaluate(body => body.textContent);
    for (const secret of [A_ERROR, 'Do you want to clear the existing cart']) expect(dialog, 'pharmacy dialog').not.toContain(secret);
    expect(await page.evaluate(() => shopFlow.confirmSwitch), 'pending switch').toBeNull();
    // B opens the pharmacies: no "switch pharmacy?" left over for A's medicine.
    await page.locator('#shopNearbyBtn').click();
    await page.getByRole('button', {name: 'Select'}).click();
    await expect(page.locator('#shopBody')).toContainText(A_PRODUCT);  // the shelf itself is public
    await expect(page.locator('#shopBody')).not.toContainText('Do you want to clear the existing cart');
    expect(problems).toEqual([]);
  });
}
