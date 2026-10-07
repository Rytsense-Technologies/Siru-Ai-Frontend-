// The inspector shows each traced step as what it was. The backend also reports
// what the speech recogniser heard (transcript), the nearest-pharmacy ranking
// (location) and what a "yes" may act on (confirmation) - none of them a tool
// call, so none may be drawn as one (shopping.js activityStep).
const { test, expect } = require('@playwright/test');

// A voice "I need Dolo 650" turn as multi_agent_framework/tracing.py traces it.
const TRACE = {
  steps: [
    {id: 1, kind: 'transcript', name: 'stt', via: 'sarvam', status: 'done', text: 'I need Dolo 650', language: 'en-IN', overlap: false},
    {id: 2, kind: 'route', name: 'pre_router', next: 'end', intent: 'product_discovery', tool: 'find_nearby_pharmacy', at_ms: 1},
    {id: 3, kind: 'tool', name: 'search_products', by: 'direct', status: 'done', at_ms: 3, duration_ms: 120, result_count: 1},
    {id: 4, kind: 'location', name: 'user_location', status: 'done', stores_queried: 20, stores_located: 20,
      nearest: [{store: 'Arun Medicals', distance_km: 0.3}, {store: 'Sri Sai Pharmacy', distance_km: 0.6}]},
    {id: 5, kind: 'tool', name: 'find_nearby_pharmacies', by: 'direct', status: 'done', at_ms: 130, duration_ms: 40, result_count: 5},
    {id: 6, kind: 'confirmation', name: 'created', status: 'done', confirmation: 'choose_pharmacy', reason: '', product: 'Dolo 650'},
    {id: 7, kind: 'confirmation', name: 'invalidated', status: 'done', confirmation: 'purchase', reason: 'selection_failed'},
  ],
  io: {calls: [], checkpoints: [], data: []},
  agent: 'direct_tool:find_nearby_pharmacy', total_ms: 180, usage: {llm_calls: 0},
};

test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname.startsWith('/v1/'), route => route.abort());
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token', expires_at: Date.now() / 1000 + 3600, user: {id: 'trace-user', role: 'buyer', name: 'Trace'}});
    await applySignedInUser();
  });
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
  await page.evaluate(async (trace) => {
    shoppingEnsureSession();
    window.turnId = crypto.randomUUID();
    shoppingTurn(turnId, {userText: 'I need Dolo 650', source: 'voice'});
    await shoppingTurnFinish(turnId, {status: 'answered', reply: 'The 5 nearest pharmacies…', trace: structuredClone(trace), cards: []});
  }, TRACE);
});

test('transcript, location and confirmation steps are drawn as themselves, not as tool calls', async ({ page }) => {
  const rows = await page.evaluate(() => [...shopEl.activityList.querySelectorAll(`[data-turn-id="${turnId}"] .trace-row`)]
    .map(row => `${row.querySelector('.trace-label').textContent} ${row.querySelector('.trace-name').textContent}`));
  expect(rows).toContain('HEARD stt · sarvam');
  expect(rows).toContain('LOCATION user_location');
  expect(rows).toContain('CONFIRM pharmacy list created');
  expect(rows).toContain('CONFIRM purchase confirmation invalidated');
  // Only the two real tool calls are tools.
  expect(rows.filter(r => r.startsWith('TOOL '))).toEqual(['TOOL search_products', 'TOOL find_nearby_pharmacies']);
});

test("the turn's Tool calls card includes them", async ({ page }) => {
  const ai = await page.evaluate(() => { panelShow('tools'); return shopEl.activityList.querySelector(`[data-turn-id="${turnId}"]`).textContent; });
  expect(ai).toContain('user_location');
  expect(ai).toContain('20 of 20 stores located');
  expect(ai).toContain('selection_failed');
  expect(ai).toContain('I need Dolo 650');
});

test('the location row shows the whole measurement: origin, each pharmacy, the method and the ETA source', async ({ page }) => {
  const detail = await page.evaluate(async () => {
    const id = crypto.randomUUID();
    shoppingTurn(id, {userText: 'nearby pharmacies', source: 'text'});
    await shoppingTurnFinish(id, {status: 'answered', reply: 'These are the nearby pharmacies.', cards: [], trace: {
      steps: [{id: 1, kind: 'location', name: 'user_location', status: 'done', stores_queried: 21, stores_located: 21,
        origin: {lat: 12.966, lng: 80.226}, distance_method: 'haversine (straight line)',
        eta_source: "provider.stores.estimated_delivery_min (the pharmacy's own estimate)",
        nearest: [{store: 'Ganesh Medicals', distance_km: 1.2, lat: 12.97, lng: 80.215, eta_min: 30},
                  {store: 'Ranjith Pharmacy', distance_km: 1.2, lat: 12.958, lng: 80.231, eta_min: null}]}],
      io: {calls: [], checkpoints: [], data: []}, agent: 'direct_tool:nearby_pharmacies', total_ms: 90, usage: {llm_calls: 0}}});
    panelShow('tools');
    return shopEl.activityList.querySelector(`[data-turn-id="${id}"]`).textContent;
  });
  expect(detail).toContain('from (12.966, 80.226)');
  expect(detail).toContain('Ganesh Medicals 1.2 km (12.97, 80.215) · ETA 30 min');
  expect(detail).toContain('Ranjith Pharmacy 1.2 km (12.958, 80.231)');
  expect(detail).not.toMatch(/80\.231\) · ETA \d/);  // no estimate: none shown
  expect(detail).toContain('haversine (straight line)');
  expect(detail).toContain("ETA source: provider.stores.estimated_delivery_min (the pharmacy's own estimate)");
});
