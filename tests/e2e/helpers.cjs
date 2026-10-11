// Shared steps of the end-to-end scenarios: signing in through the real sign-in
// form, sending a chat message, and asking the real API directly (as that user)
// for what the page shows - so a test compares the page with the server.
const { expect } = require('@playwright/test');
const { stack } = require('./stack.cjs');

function env() {
  return stack();
}

async function open(page) {
  const { web, api } = env();
  // The API this browser talks to (app.js savedApiBase) - the stack's.
  await page.addInitScript(base => { try { localStorage.setItem('pharmacy_api_base', base); } catch {} }, api);
  await page.goto(`${web}/index.html`);
}

async function signIn(page, account) {
  await open(page);
  await page.fill('#loginEmail', account.email);
  await page.fill('#loginPassword', account.password);
  const opened = page.waitForResponse(r => r.url().includes('/v1/concierge/open'), { timeout: 30_000 }).catch(() => null);
  await page.click('#loginBtn');
  await expect(page.locator('#appView')).toBeVisible();
  await opened;  // the session open (due check-ins, never a typed greeting) is in first
  // The location prompt opens a moment after sign-in, as a modal: until it is
  // dismissed the rest of the page is inert (typing and Enter never reach the
  // chat - what made the first E2E run's messages vanish unsent).
  await page.waitForSelector('dialog[open]', { timeout: 8000 }).catch(() => null);
  for (let i = 0; i < 5 && await page.$('dialog[open]'); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('#askInput')).toBeEnabled();
}

// The delivery location a scenario needs before it shops (an add asks for one, as a real user is asked): set
// through the app's own location dialog, with the browser's geolocation granted at a fixed place. E2E_LAT /
// E2E_LNG: where the stack's pharmacies are (default: near the local sandbox's seeded Chennai pharmacies).
function place() {
  return { latitude: Number(process.env.E2E_LAT || 12.9791), longitude: Number(process.env.E2E_LNG || 80.2209),
    accuracy: 20 };
}

async function setLocation(page) {
  const { web } = env();
  await page.context().grantPermissions(['geolocation'], { origin: web });
  await page.context().setGeolocation(place());
  await page.click('#locationChangeBtn');
  await page.click('#locationUseDeviceBtn');
  await expect(page.locator('#locationRowTitle')).not.toHaveText('No location set', { timeout: 15_000 });
  for (let i = 0; i < 5 && await page.$('dialog[open]'); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await expect(page.locator('dialog[open]')).toHaveCount(0);
}

// "sandbox": the stack's catalog, stores and orders are its own local sandbox (a typed order is placed at once);
// otherwise the client's data is read only and an order is prepared for a Confirm tap (actions/service.py).
async function stackMode() {
  const response = await fetch(`${env().api}/readyz`);
  const body = await response.json().catch(() => ({}));
  return body?.checks?.client_db === 'not_used' ? 'sandbox' : 'readonly';
}

async function token(page) {
  return page.evaluate(() => authToken());
}

// The API itself, with this page's own login token.
async function api(page, path, init = {}) {
  const { api: base } = env();
  const bearer = await token(page);
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, ...(init.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

async function login(email, password) {
  const { api: base } = env();
  const response = await fetch(`${base}/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Sends one message and waits for the reply in THAT turn's block (each turn
// is its own .chat-turn: the user's bubble, then the reply).
async function say(page, text) {
  // Send is disabled until the pharmacy has loaded and while a turn is running,
  // and Enter then submits nothing (the text just stays) - wait for it first.
  await expect(page.locator('#askForm [type="submit"]')).toBeEnabled({ timeout: 60_000 });
  await page.fill('#askInput', text);
  await page.press('#askInput', 'Enter');
  const turn = page.locator('.chat-turn').filter({ has: page.locator('.chat-bubble.user', { hasText: text }) }).last();
  const reply = turn.locator('.chat-bubble.assistant');
  await expect(reply).toBeVisible({ timeout: 90_000 });
  return { text: (await reply.textContent()).trim(), turn };
}

const SCRIPTS = {
  'ta-IN': /[஀-௿]/, 'hi-IN': /[ऀ-ॿ]/, 'te-IN': /[ఀ-౿]/,
};

// The signed-in user's id, as GET /v1/auth/me returns it (the account's public view: `id`).
async function meId(page) {
  const me = await api(page, '/v1/auth/me');
  return me.body.user_id || me.body.id;
}

module.exports = { env, open, signIn, setLocation, place, stackMode, token, api, login, say, meId,
  SCRIPTS, expect };
