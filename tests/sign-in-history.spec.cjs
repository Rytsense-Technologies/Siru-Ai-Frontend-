// Bug #12B: every sign-in ran userForgetDevice(), which removes every user's chats, activity,
// session lists, locations and session pointers - so signing in on a SECOND TAB as the same
// person wiped the first tab's saved chat and Inspector activity (localStorage is shared by
// the tabs; the token and the session pointer are per tab, so each tab signs in). Now a
// sign-in removes only what OTHER people left on the device (users.js userForgetOthers):
// the signing-in user's own keys stay. Sign-out and "Forget everything" still remove all.
// Two pages of one browser context share localStorage and each has its own sessionStorage,
// as two tabs do. The page's own sign-in form and code run; only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'};

async function stubApi(page) {
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/auth/login') {
      const id = String(request.postDataJSON().email).split('@')[0];
      return route.fulfill({headers: cors, json: {access_token: `token-${id}`, expires_at: Date.now() / 1000 + 3600,
                                                  user: {id, role: 'buyer', name: id}}});
    }
    if (path === '/v1/auth/demo-merchants') {
      return route.fulfill({headers: cors, json: {source: 'client_rds', merchants: [
        {merchantId: 'm-1', stores: [{name: 'Arun Medicals', isOpen: true, catalogItems: 3, orders: 1}]}]}});
    }
    if (path === '/v1/auth/demo-merchants/login') {
      return route.fulfill({headers: cors, json: {access_token: 'token-m', expires_at: Date.now() / 1000 + 3600,
                                                  user: {id: 'merchant-m-1', role: 'merchant', name: 'Arun Medicals'}}});
    }
    return route.abort();
  });
}

async function open(context) {
  const page = await context.newPage();
  await stubApi(page);
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  return page;
}

// The real sign-in form.
async function signIn(page, id) {
  await page.fill('#loginEmail', `${id}@local.test`);
  await page.fill('#loginPassword', 'test-password');
  await page.locator('#loginForm [type="submit"]').click();
  await expect.poll(() => page.evaluate(() => getUserId())).toBe(id);
  await page.evaluate(async () => {  // the location prompt opens after sign-in: close it
    for (let i = 0; i < 40 && !locEl.locationDialog.open; i++) await new Promise(resolve => setTimeout(resolve, 50));
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  });
}

// A real answered turn: saved to this user's chat (siru_chat_) and activity (siru_activity_).
async function chat(page, text) {
  await page.evaluate(async text => {
    shoppingEnsureSession();  // as sending a message does: the conversation this chat belongs to
    const id = crypto.randomUUID();
    shoppingTurn(id, {userText: text});
    await shoppingTurnFinish(id, {reply: `Answer to ${text}`, trace: {agent: 'x', steps: [{kind: 'route', name: 'pre_router', status: 'done'}]}});
  }, text);
}

const keys = (page, storage = 'localStorage') => page.evaluate(s => Object.keys(window[s]).filter(k => k.startsWith('siru_')).sort(), storage);
const mine = (list, id) => list.filter(k => k === `siru_sessions_${id}` || k.startsWith(`siru_chat_${id}_`) || k.startsWith(`siru_activity_${id}_`));

test('the same user signing in on a second tab keeps the first tab\'s chat and activity', async ({ context }) => {
  const tabA = await open(context);
  await signIn(tabA, 'user-a');
  await chat(tabA, 'I need Dolo 650');
  const before = mine(await keys(tabA), 'user-a');
  expect(before.filter(k => k.startsWith('siru_chat_'))).toHaveLength(1);
  expect(before.filter(k => k.startsWith('siru_activity_'))).toHaveLength(1);

  const tabB = await open(context);
  await signIn(tabB, 'user-a');
  expect(mine(await keys(tabA), 'user-a')).toEqual(expect.arrayContaining(before));  // nothing of user-a's removed

  await tabA.reload();
  await tabA.waitForLoadState('load');
  await expect(tabA.locator('#chatMessages .chat-turn')).toHaveCount(1);
  await expect(tabA.locator('#chatMessages')).toContainText('I need Dolo 650');
  expect(await tabA.evaluate(() => JSON.parse(localStorage.getItem(activityKey()) || '[]').length)).toBe(1);
  expect(await tabA.evaluate(() => shopEl.activityList.children.length)).toBeGreaterThan(0);  // the Inspector's activity, shown
});

test('a different user signing in removes everything the previous user left', async ({ context }) => {
  const tabA = await open(context);
  await signIn(tabA, 'user-a');
  await chat(tabA, 'I need Dolo 650');
  await tabA.evaluate(() => locationSave({source: 'manual', address: 'Pallikaranai, Chennai', pincode: '600100', lat: 12.93, lng: 80.21}));
  expect(mine(await keys(tabA), 'user-a').length).toBeGreaterThan(0);

  // The same tab, user-a's session over (expired - no sign-out wipe), user-b signs in.
  await tabA.evaluate(async () => { authSave(null); await applySignedInUser(); });
  expect(await keys(tabA, 'sessionStorage')).toEqual(expect.arrayContaining(['siru_current_session_user-a', 'siru_location_user-a']));
  await signIn(tabA, 'user-b');
  const left = [...await keys(tabA), ...await keys(tabA, 'sessionStorage')];
  expect(left.filter(k => k.includes('user-a'))).toEqual([]);  // chat, activity, sessions, location, pointer
});

test('user "a" never keeps "ab"\'s or "a_b"\'s keys, and keeps its own', async ({ context }) => {
  const tab = await open(context);
  const uuid = '11111111-2222-3333-4444-555555555555';
  await tab.evaluate(uuid => {
    for (const id of ['a', 'ab', 'a_b']) {
      localStorage.setItem(`siru_chat_${id}_${uuid}`, '[]');
      localStorage.setItem(`siru_activity_${id}_${uuid}`, '[]');
      localStorage.setItem(`siru_sessions_${id}`, '[]');
    }
    localStorage.setItem('siru_api_base_example', 'kept');  // not user data: never touched
  }, uuid);
  await signIn(tab, 'a');
  const left = await keys(tab);
  expect(left).toEqual(expect.arrayContaining([`siru_activity_a_${uuid}`, 'siru_api_base_example', `siru_chat_a_${uuid}`, 'siru_sessions_a']));
  expect(left.filter(k => k.includes('_ab') || k.includes('a_b'))).toEqual([]);
});

test('the demo-merchant sign-in follows the same rule', async ({ context }) => {
  const tab = await open(context);
  const uuid = '11111111-2222-3333-4444-555555555555';
  await tab.evaluate(uuid => {
    localStorage.setItem(`siru_chat_merchant-m-1_${uuid}`, '[]');
    localStorage.setItem(`siru_chat_user-a_${uuid}`, '[]');
  }, uuid);
  // The merchant list (GET /v1/auth/demo-merchants) shows only on a development entry: its one option, put in
  // place here; the button's own handler signs in.
  await tab.evaluate(() => {
    const option = document.createElement('option');
    option.value = 'm-1';
    option.textContent = 'Arun Medicals';
    loginEl.demoMerchantSelect.replaceChildren(option);
    loginEl.demoMerchantBtn.disabled = false;
    loginEl.demoMerchantBtn.click();
  });
  await expect.poll(() => tab.evaluate(() => getUserId())).toBe('merchant-m-1');
  expect(await keys(tab)).toEqual([`siru_chat_merchant-m-1_${uuid}`]);
});

test('signing out still removes everything, the user\'s own included', async ({ context }) => {
  const tab = await open(context);
  await signIn(tab, 'user-a');
  await chat(tab, 'I need Dolo 650');
  expect(mine(await keys(tab), 'user-a').length).toBeGreaterThan(0);
  await tab.evaluate(() => signOut());
  expect(await keys(tab)).toEqual([]);
  expect(await keys(tab, 'sessionStorage')).toEqual([]);
});
