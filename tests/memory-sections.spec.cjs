// The Memory tab's sections are each their own source, and say honestly what
// they have: household profiles (GET /v1/household/me), the cart, and the
// orders (SIRU + this app's confirmed ones). Loading, empty and failed differ;
// a failure is never shown as "none"; another user's records never stay on
// screen - not after a switch, not after signing out. Only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, PATCH, OPTIONS'};
let api;  // per user: {household, siruOrders, demo} - a value, or a status number to fail with

const member = (id, label, extra = {}) => ({id, relationship: 'mother', label, age_years: null, note: '',
  source: 'user_entered', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', ...extra});

test.beforeEach(async ({ page }) => {
  api = new Map();
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    const user = String(request.headers().authorization || '').replace('Bearer token-', '');
    const mine = api.get(user) || {};
    const answer = value => typeof value === 'number' || value === undefined
      ? route.fulfill({status: value || 503, headers: cors, json: {detail: 'unavailable'}})
      : (value.then ? value.then(v => route.fulfill({headers: cors, json: v})) : route.fulfill({headers: cors, json: value}));
    if (path === '/v1/household/me' && request.method() === 'GET') {
      const h = mine.household;
      return answer(typeof h === 'number' || h === undefined ? h : (h.then ? h.then(members => ({members})) : {members: h}));
    }
    if (path.includes('/notes/') && request.method() === 'DELETE') {
      const [, , , , memberId, , noteId] = path.split('/');
      for (const m of mine.household || []) if (m.id === memberId) m.health_notes = (m.health_notes || []).filter(n => n.id !== noteId);
      return route.fulfill({headers: cors, json: {deleted: true, id: noteId}});
    }
    if (path.startsWith('/v1/household/me/') && request.method() === 'DELETE') {
      const id = path.split('/').pop();
      mine.household = (mine.household || []).filter(m => m.id !== id);
      return route.fulfill({headers: cors, json: {deleted: true, id}});
    }
    if (path.startsWith('/v1/pharmacy/orders/')) return answer(mine.siruOrders);
    if (path === '/v1/actions/demo') return answer(mine.demo);
    if (path === '/v1/concierge/refills') return answer(mine.refills === undefined ? {items: []} : mine.refills);
    if (path === '/v1/prescriptions/me') return answer(mine.rx === undefined ? {prescriptions: []} : mine.rx);
    if (path.startsWith('/v1/prescriptions/me/') && request.method() === 'PATCH') {
      mine.patched = JSON.parse(request.postData() || '{}');
      if (mine.refuse) return route.fulfill({status: 409, headers: cors, json: {detail: {
        message: 'Some details could not be read for sure.', uncertain_fields: ['items.1']}}});
      return route.fulfill({headers: cors, json: {prescription: {}}});
    }
    if (path === '/v1/memory/me') return route.fulfill({headers: cors, json: {items: [], memory_enabled: true}});
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
    window.settle = () => new Promise(resolve => setTimeout(resolve, 150));
    window.sections = () => ({
      household: [...memoryEl.householdList.querySelectorAll('.memory-text')].map(n => n.textContent),
      householdCount: memoryEl.householdCount.textContent,
      householdEmpty: !memoryEl.householdEmpty.hidden,
      householdStatus: memoryEl.householdStatus.textContent,
      orders: memoryEl.memoryOrders.textContent,
      cart: memoryEl.memoryCart.textContent,
      stm: memoryEl.stmRecent.children.length,
    });
  });
});

test('household profiles the user entered are listed with their details, and one can be deleted', async ({ page }) => {
  api.set('a', {household: [member('m1', 'Amma', {age_years: 62, note: 'prefers syrups'}), member('m2', 'Kavin', {relationship: 'son'})],
    siruOrders: [], demo: {orders: [], bookings: []}});
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => signInAs('a'));
  // No saved location: sign-in asks for one (location-ui.js). Dismiss it, as a user would.
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
  const shown = await page.evaluate(async () => { panelShow('memory'); await householdRefresh(); return sections(); });
  expect(shown).toMatchObject({household: ['Amma', 'Kavin'], householdCount: '2', householdEmpty: false});
  const text = await page.evaluate(() => memoryEl.householdList.textContent);
  expect(text).toContain('Age 62');
  expect(text).toContain('prefers syrups');
  expect(text).toContain('Entered by you');
  await page.locator('#householdList .memory-forget').first().click();
  await expect.poll(() => page.evaluate(() => sections().household)).toEqual(['Kavin']);
  expect(await page.evaluate(() => sections().householdCount)).toBe('1');
});

test('a failed household load is not "no profiles"; none stored is an honest empty state', async ({ page }) => {
  api.set('a', {household: 503});
  const failed = await page.evaluate(async () => { await signInAs('a'); await householdRefresh(); return sections(); });
  expect(failed).toMatchObject({household: [], householdCount: '–', householdEmpty: false});
  expect(failed.householdStatus).toContain("Couldn't load household profiles just now.");
  api.set('b', {household: []});
  const empty = await page.evaluate(async () => { await signInAs('b'); await householdRefresh(); return sections(); });
  expect(empty).toMatchObject({household: [], householdCount: '0', householdEmpty: true, householdStatus: ''});
});

test('orders: a failed source is said, and "No orders yet." only when both answered', async ({ page }) => {
  api.set('a', {siruOrders: 503, demo: {orders: [], bookings: []}});
  const partly = await page.evaluate(async () => { await signInAs('a'); await memoryOrdersRefresh('a'); return sections(); });
  expect(partly.orders).toContain("Couldn't load your SIRU orders just now");
  expect(partly.orders).not.toContain('No orders yet.');
  api.set('b', {siruOrders: [], demo: {orders: [], bookings: []}});
  const none = await page.evaluate(async () => { await signInAs('b'); await memoryOrdersRefresh('b'); return sections(); });
  expect(none.orders).toBe('No orders yet.');
});

test("switching users never leaves the previous user's household or orders on screen", async ({ page }) => {
  api.set('a', {household: [member('m1', 'Amma')], demo: {orders: [{id: 'A-ORDER-1', status: 'CONFIRMED_DEMO',
    createdAt: '2026-10-01T10:00:00Z', items: [], totalPaise: 1000}], bookings: []}, siruOrders: []});
  await page.evaluate(async () => { await signInAs('a'); await householdRefresh(); await memoryOrdersRefresh('a'); });
  expect((await page.evaluate(() => sections())).orders).toContain('A-ORDER-1');
  // B's answers are held open: while they load, nothing of A's may show.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  api.set('b', {household: held.then(() => []), siruOrders: held.then(() => []),
    demo: held.then(() => ({orders: [], bookings: []}))});
  const during = await page.evaluate(async () => {
    await signInAs('b');
    householdRefresh(); memoryOrdersRefresh('b');
    await settle();
    return sections();
  });
  expect(during.household).toEqual([]);
  expect(during.orders).not.toContain('A-ORDER-1');
  expect(during.orders).toContain('Loading orders…');
  release();
  await expect.poll(() => page.evaluate(() => sections().orders)).toBe('No orders yet.');
});

test('signing out clears every section of the Memory tab', async ({ page }) => {
  api.set('a', {household: [member('m1', 'Amma')], siruOrders: [], demo: {orders: [{id: 'A-ORDER-1', status: 'CONFIRMED_DEMO',
    createdAt: '2026-10-01T10:00:00Z', items: [], totalPaise: 1000}], bookings: []}});
  await page.evaluate(async () => { await signInAs('a'); await householdRefresh(); await memoryOrdersRefresh('a'); });
  const after = await page.evaluate(async () => { await signOut(); await settle(); return sections(); });
  expect(after.household).toEqual([]);
  expect(after.orders).toBe('');
  expect(after.cart).toBe('Sign in to see your cart.');
  expect(after.stm).toBe(0);
});

test('a cart that could not be loaded says so - not "Loading the cart…" forever', async ({ page }) => {
  const cart = await page.evaluate(async () => {
    await signInAs('a');
    memoryCartRender(null, {failed: 'Service is temporarily unavailable. Please try again.'});
    return sections().cart;
  });
  expect(cart).toContain("Couldn't load your cart just now.");
  expect(cart).not.toContain('Loading the cart');
});

test('a member named in a conversation says so, with when, and keeps the earlier age', async ({ page }) => {
  api.set('a', {household: [member('m1', 'Saroja', {age_years: 63, source: 'conversation', updated_at: '2026-10-02T09:00:00Z',
    history: [{field: 'age_years', value: 62, until: '2026-10-02T09:00:00Z', source: 'conversation'}]})]});
  const text = await page.evaluate(async () => { await signInAs('a'); await householdRefresh(); return memoryEl.householdList.textContent; });
  expect(text).toContain('Saroja');
  expect(text).toContain('Age 63');
  expect(text).toContain('From a conversation');
  expect(text).not.toContain('Entered by you');
  expect(text).toContain('Earlier: age 62');
});

test('refills show what the server predicted; none is an honest empty state, a failure is not "none"', async ({ page }) => {
  api.set('a', {refills: {items: [{medName: 'Amlong 5', dueDate: '2026-10-05', daysUntil: 3, source: 'order_history'}]}});
  const due = await page.evaluate(async () => { await signInAs('a'); await memoryRefillsRefresh('a'); return memoryEl.memoryRefills.textContent; });
  expect(due).toContain('Amlong 5');
  expect(due).toContain('Due in 3 days');
  expect(due).toContain('From your order history');
  api.set('b', {refills: {items: []}});
  const none = await page.evaluate(async () => { await signInAs('b'); await memoryRefillsRefresh('b'); return memoryEl.memoryRefills.textContent; });
  expect(none).toContain('No refills due');
  expect(none).not.toContain('Amlong');
  api.set('c', {refills: 503});
  const failed = await page.evaluate(async () => { await signInAs('c'); await memoryRefillsRefresh('c'); return memoryEl.memoryRefills.textContent; });
  expect(failed).toContain("Couldn't load refills just now.");
});

test("a household member's reported allergy shows as user-reported, with its source and date, and can be deleted", async ({ page }) => {
  api.set('a', {household: [member('m1', 'Saroja', {age_years: 62, source: 'conversation', health_notes: [
    {id: 'n1', kind: 'allergy', value: 'Dolo 650', source: 'conversation', recorded_at: '2026-10-02T09:00:00Z', status: 'user_reported'}]})]});
  page.on('dialog', dialog => dialog.accept());
  const text = await page.evaluate(async () => { await signInAs('a'); panelShow('memory'); await householdRefresh(); return memoryEl.householdList.textContent; });
  expect(text).toContain('Allergy: Dolo 650');
  expect(text).toContain('Household health');
  expect(text).toContain('User-reported; not medically verified');
  expect(text).toContain('From a conversation');
  // (the sign-in's location dialog may be open over the panel)
  await page.evaluate(() => document.querySelector('.household-health .memory-forget').click());
  await expect.poll(() => page.evaluate(() => memoryEl.householdList.textContent)).not.toContain('Dolo 650');
  expect(await page.evaluate(() => sections().household)).toEqual(['Saroja']);  // the profile stays
});

test('"Nothing remembered yet" is not shown while household records exist', async ({ page }) => {
  api.set('a', {household: [member('m1', 'Saroja')]});
  const state = await page.evaluate(async () => {
    await signInAs('a'); await memoryRefresh(); await householdRefresh(); await settle();
    return {empty: memoryEl.memoryEmpty.textContent, top: memoryEl.memoryCountTop.textContent};
  });
  expect(state.empty).not.toBe('Nothing remembered yet.');
  expect(state.empty).toContain('household');
  expect(state.top).toBe('1');
});

test('persistent records are labelled Long-Term Memory, the conversation Short-Term; no "Add a person" form', async ({ page }) => {
  api.set('a', {household: [member('m1', 'Saroja', {source: 'conversation', health_notes: [
    {id: 'n1', kind: 'allergy', value: 'Dolo 650', source: 'conversation', recorded_at: '2026-10-02T09:00:00Z', status: 'user_reported'}]})]});
  const tab = await page.evaluate(async () => {
    await signInAs('a'); panelShow('memory'); await householdRefresh();
    const panel = document.getElementById('memoryTab');
    return {heads: [...panel.querySelectorAll('h3')].map(h => h.textContent.replace(/\s+/g, ' ').trim()),
      card: memoryEl.householdList.textContent, form: !!document.getElementById('householdForm'),
      addPerson: panel.textContent.includes('Add a person')};
  });
  expect(tab.heads.some(h => h.startsWith('Long-Term Memory Personal facts'))).toBe(true);
  expect(tab.heads.some(h => h.startsWith('Long-Term Memory Household profiles'))).toBe(true);
  expect(tab.heads.some(h => h.startsWith('Short-Term Memory This conversation'))).toBe(true);
  expect(tab.card).toContain('Long-term');
  expect(tab.card).toContain('Long-term · Household health');
  expect(tab.form).toBe(false);
  expect(tab.addPerson).toBe(false);
});

const RX = {id: 'rx1', patient_name: 'Saroja', prescription_date: '2026-09-28', uploaded_at: '2026-10-02T09:00:00Z',
  items: [{name: 'Amlong 5', strength: '5 mg', unclear: false}, {name: 'Telma 40', strength: null, unclear: true}],
  ocr_status: 'extracted', verification: 'awaiting_user_confirmation', uncertain_fields: ['items.1']};

test('a saved prescription shows its own date, the patient, the unclear line, and awaits confirmation', async ({ page }) => {
  api.set('a', {rx: {prescriptions: [RX]}, refuse: true});
  const text = await page.evaluate(async () => { await signInAs('a'); await rxRefresh('a'); return memoryEl.rxList.textContent; });
  expect(text).toContain('Patient: Saroja');
  expect(text).toContain('Prescription date: 2026-09-28');
  expect(text).toContain('Uploaded');
  expect(text).toContain('Telma 40 (unclear - please check)');
  expect(text).toContain('OCR extracted - awaiting your confirmation');
  // Confirming while a line is still uncertain: the server refuses, and the user is told what to check.
  await page.evaluate(() => memoryEl.rxList.querySelector('form').requestSubmit());
  await expect.poll(() => page.evaluate(() => memoryEl.rxStatus.textContent)).toBe('Please check: medicine 1.');
  expect(api.get('a').patched).toMatchObject({confirm: true, patient_name: 'Saroja', prescription_date: '2026-09-28'});
});

test('the emergency card shows Call 112 and Call 108 as tel: links and folded instructions', async ({ page }) => {
  const card = await page.evaluate(() => {
    const entry = shoppingToolCard({kind: 'ui', title: 'Emergency', accent: 'danger', blocks: [
      {type: 'note', tone: 'danger', text: 'Get emergency medical help immediately.'},
      {type: 'actions', buttons: [
        {label: 'Call 112 — Emergency assistance', intent: 'call_emergency', style: 'danger', payload: {tel: '112'}},
        {label: 'Call 108 — Ambulance (where available)', intent: 'call_emergency', style: 'danger', payload: {tel: '108'}}]},
      {type: 'details', summary: 'Get emergency help instructions', items: ['Call 112 or 108 now.', 'Stay with the person.']}]}, '');
    return {links: [...entry.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]),
      summary: entry.querySelector('details summary')?.textContent, steps: entry.querySelectorAll('details li').length,
      danger: !!entry.querySelector('.accent-danger')};
  });
  expect(card.links).toEqual([['Call 112 — Emergency assistance', 'tel:112'], ['Call 108 — Ambulance (where available)', 'tel:108']]);
  expect(card.summary).toBe('Get emergency help instructions');
  expect(card.steps).toBe(2);
  expect(card.danger).toBe(true);
});
