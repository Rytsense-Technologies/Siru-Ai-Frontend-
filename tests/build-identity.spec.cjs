// Which build is running, and which build answered (production, 7 Oct: "the same URL behaves differently on
// two laptops"): the page knows its own build (version.js), says when a newer one is deployed, and the
// Inspector shows each turn's user, conversation, turn, frontend and backend builds and state version.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname.startsWith('/v1/'), route => route.abort());
  await page.goto('/index.html');
  await page.waitForLoadState('load');
});

test('the page knows the build it is running', async ({ page }) => {
  const [running, loaded] = await page.evaluate(() => [FRONTEND_BUILD,
    new URL([...document.scripts].find(s => s.src.includes('version.js')).src).searchParams.get('v')]);
  expect(running).toBe(loaded);
  expect(running).not.toBe('unknown');
});

test('a newer deployed build is said - never a reload on its own', async ({ page }) => {
  await page.evaluate(() => frontendCheckBuild());
  await expect(page.locator('#buildBanner')).toHaveCount(0);  // the same build: nothing said
  await page.route(url => url.pathname === '/index.html' && url.search.includes('check='),
    route => route.fulfill({contentType: 'text/html', body: '<script src="version.js?v=99999"></script>'}));
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(() => frontendCheckBuild());
  await expect(page.locator('#buildBanner')).toContainText('A newer version of Siru is available.');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);  // not reloaded
});

test("the Inspector names each turn's user, conversation, turn, builds and state version", async ({ page }) => {
  await page.evaluate(async () => {
    authSave({access_token: 'token', expires_at: Date.now() / 1000 + 3600, user: {id: 'build-user', role: 'buyer', name: 'B'}});
    await applySignedInUser();
  });
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
  const detail = await page.evaluate(async () => {
    shoppingEnsureSession();
    const id = crypto.randomUUID();
    shoppingTurn(id, {userText: 'I need Dolo 650', source: 'text'});
    await shoppingTurnFinish(id, {status: 'answered', reply: 'These are the nearest pharmacies.', cards: [], trace: {
      steps: [], io: {calls: [], checkpoints: [], data: []}, agent: 'direct_tool:find_nearby_pharmacy', total_ms: 90,
      usage: {llm_calls: 0}, identity: {user_id: 'build-user', conversation_id: 'conv-1', turn_id: 'req-1',
        backend_build: 'abc1234/def456789012', environment: 'production', state_version: 'f00d'}}});
    panelShow('tools');
    return shopEl.activityList.querySelector(`[data-turn-id="${id}"]`).textContent;
  });
  for (const part of ['turn req-1', 'conversation conv-1', 'user build-user', 'backend abc1234/def456789012',
    'state f00d', 'production']) expect(detail).toContain(part);
  expect(detail).toContain(`frontend ${await page.evaluate(() => FRONTEND_BUILD)}`);
});

test("the Inspector shows the turn's intent, the conversation's state and the model used", async ({ page }) => {
  await page.evaluate(async () => {
    authSave({access_token: 'token', expires_at: Date.now() / 1000 + 3600, user: {id: 'build-user', role: 'buyer', name: 'B'}});
    await applySignedInUser();
  });
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
  const detail = await page.evaluate(async () => {
    shoppingEnsureSession();
    const id = crypto.randomUUID();
    shoppingTurn(id, {userText: 'second one', source: 'text'});
    await shoppingTurnFinish(id, {status: 'answered', reply: 'Cetirizine 10 mg is in stock at Beta.', cards: [], trace: {
      steps: [], io: {calls: [], checkpoints: [], data: []}, agent: 'direct_tool:select_pharmacy', total_ms: 90,
      usage: {llm_calls: 1, by_model: {'gemini-flash-lite-latest': {}}},
      identity: {user_id: 'build-user', conversation_id: 'conv-2', turn_id: 'req-2', backend_build: 'unknown/abc',
        environment: 'production', state_version: 'beef',
        intent: {domain: 'commerce', intent: 'select_pharmacy', action: '', entity: 'Cetirizine 10 mg'},
        state: {product: 'Cetirizine 10 mg', list_id: '1a2b3c4d', list: ['1) Alpha', '2) Beta'], selected: 'Beta', offer: true}}}});
    panelShow('tools');
    return shopEl.activityList.querySelector(`[data-turn-id="${id}"]`).textContent;
  });
  for (const part of ['select_pharmacy', 'domain commerce', 'entity Cetirizine 10 mg', 'product Cetirizine 10 mg',
    'list 1a2b3c4d: 1) Alpha; 2) Beta', 'selected Beta', 'offer waiting for yes', 'gemini-flash-lite-latest'])
    expect(detail).toContain(part);
});
