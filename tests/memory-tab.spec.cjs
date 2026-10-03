// The Memory tab's count is what the server holds for the signed-in user
// (GET /v1/memory/me) - never a number the page made up: a load that failed
// (the API's app database unreachable: 503) shows no count and no "Nothing
// remembered yet.", and never keeps another user's list. The page's own
// memory code runs; only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS'};
const item = (id, text) => ({id, user_id: 'u', text, category: 'other', source: 'chat', consent: 'granted',
  created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z'});

let answers;  // GET /v1/memory/me, by user: {status, items}
let forgotten;  // the forget-everything calls the page made

test.beforeEach(async ({ page }) => {
  answers = new Map();
  forgotten = [];
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/memory/me' && request.method() === 'DELETE') {
      forgotten.push(path);
      return route.fulfill({headers: cors, json: {complete: true}});
    }
    if (path === '/v1/concierge/conversation/new') {
      forgotten.push(path);
      return route.fulfill({headers: cors, json: {ok: true}});
    }
    if (path === '/v1/memory/me') {
      const user = String(request.headers().authorization || '').replace('Bearer token-', '');
      const answer = answers.get(user) || {status: 503};
      if (answer.status !== 200) return route.fulfill({status: answer.status, headers: cors, json: {detail: 'unavailable'}});
      return route.fulfill({headers: cors, json: {user_id: user, memory_enabled: true, consent_switch_available: true,
        items: answer.items}});
    }
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    window.signInAs = async id => {
      authSave({access_token: `token-${id}`, expires_at: Date.now() / 1000 + 3600, user: {id, role: 'buyer', name: id}});
      await applySignedInUser();
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    };
    window.memoryShown = async () => {
      await memoryRefresh();
      return {count: memoryEl.memoryCount.textContent, top: memoryEl.memoryCountTop.textContent,
        empty: !memoryEl.memoryEmpty.hidden, items: [...memoryEl.memoryList.querySelectorAll('.memory-text')].map(n => n.textContent),
        status: memoryEl.memoryStatus.textContent};
    };
  });
});

test('a failed load shows no count and no "nothing remembered" - not 0', async ({ page }) => {
  const shown = await page.evaluate(async () => { await signInAs('patient-a'); return memoryShown(); });
  expect(shown).toMatchObject({count: '–', top: '–', empty: false, items: []});
  expect(shown.status).toContain("Couldn't load memory just now.");
});

test('stored facts are counted; none stored is an honest 0', async ({ page }) => {
  answers.set('patient-a', {status: 200, items: [item(1, 'Prefers generic medicines'), item(2, 'Allergic to sulfa')]});
  answers.set('patient-b', {status: 200, items: []});
  const a = await page.evaluate(async () => { await signInAs('patient-a'); return memoryShown(); });
  expect(a).toMatchObject({count: '2', top: '2', empty: false, items: ['Prefers generic medicines', 'Allergic to sulfa']});
  const b = await page.evaluate(async () => { await signInAs('patient-b'); return memoryShown(); });
  expect(b).toMatchObject({count: '0', top: '0', empty: true, items: []});
});

test('a later failure keeps this user\'s loaded list, and never shows another user\'s', async ({ page }) => {
  answers.set('patient-a', {status: 200, items: [item(1, 'Prefers generic medicines')]});
  expect(await page.evaluate(async () => { await signInAs('patient-a'); return memoryShown(); }))
    .toMatchObject({count: '1', items: ['Prefers generic medicines']});
  answers.set('patient-a', {status: 503});
  const again = await page.evaluate(() => memoryShown());
  expect(again).toMatchObject({count: '1', items: ['Prefers generic medicines'], empty: false});
  expect(again.status).toContain("Couldn't load memory just now.");
  const b = await page.evaluate(async () => { await signInAs('patient-b'); return memoryShown(); });
  expect(b).toMatchObject({count: '–', items: [], empty: false});
});

test('"Forget everything" also starts a new conversation - nothing of the forgotten one stays in use', async ({ page }) => {
  answers.set('a', {status: 200, items: [item(1, 'Prefers evening delivery')]});
  page.on('dialog', dialog => dialog.accept());
  const before = await page.evaluate(async () => { await signInAs('a'); return userStartSession('a'); });
  await page.evaluate(() => memoryEl.memoryForgetAll.click());
  await expect.poll(() => forgotten.length).toBe(2);
  expect(forgotten).toEqual(['/v1/memory/me', '/v1/concierge/conversation/new']);
  const after = await page.evaluate(() => userSession('a'));
  expect(after).not.toBeNull();
  expect(after).not.toBe(before);  // a new conversation id, not the forgotten one
  await expect(page.locator('#memoryStatus')).toContainText('Forgotten');
});

test('a SIRU order\'s receipt is never titled or noted as a demo; a demo order says so', async ({ page }) => {
  const shown = await page.evaluate(async () => {
    await signInAs('a');
    const read = () => ({title: document.getElementById('orderTitle').textContent,
      noteHidden: document.getElementById('orderDemoNote').hidden});
    orderDialogShow({kind: 'order', number: 'SIRU-1042', source: 'siru', items: [], total_paise: 4500});
    const real = read();
    shopEl.orderDialog.close();
    orderDialogShow({kind: 'order', number: 'DEMO-71C0782A', source: 'demo', items: [], total_paise: 2200});
    const demo = read();
    shopEl.orderDialog.close();
    return {real, demo};
  });
  expect(shown.real).toEqual({title: 'Order SIRU-1042', noteHidden: true});
  expect(shown.demo).toEqual({title: 'Demo order placed', noteHidden: false});
});
