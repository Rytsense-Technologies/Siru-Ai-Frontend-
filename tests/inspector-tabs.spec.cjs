// The Inspector's AI layer, Trace and Integration tabs and the guardrail
// status line - each from this conversation's real traces, or (Integration) a
// live GET /healthz + /readyz - never sample values; empty, failed and narrow
// screens included. Only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'};
const TRACE = {
  steps: [
    {id: 1, kind: 'route', name: 'pre_router', next: 'commerce_agent', intent: 'add_to_cart', at_ms: 2, duration_ms: 3},
    {id: 2, kind: 'llm', name: 'gemini-flash', status: 'done', at_ms: 10, duration_ms: 410, tokens_in: 1180, tokens_out: 42},
    {id: 3, kind: 'tool', name: 'search_products', by: 'model', status: 'done', at_ms: 425, duration_ms: 126},
    {id: 4, kind: 'guard', name: 'pharmacy_selection', verdict: 'required', detail: 'no pharmacy chosen', at_ms: 500},
    {id: 5, kind: 'guard', name: 'pii_mask', verdict: 'pass', at_ms: 1},
  ],
  io: {calls: [{name: 'search_products', plane: 'core', tables_read: ['catalog_items', 'stores'], tables_written: []}], checkpoints: [], data: []},
  agent: 'commerce_agent', total_ms: 950, usage: {llm_calls: 1, tokens_in: 1180, tokens_out: 42, by_model: {'gemini-flash': {calls: 1}}},
};
const NEARBY = {steps: [{id: 1, kind: 'tool', name: 'find_nearby_pharmacies', by: 'direct', status: 'done', at_ms: 3}],
  io: {calls: [], checkpoints: [], data: []}, agent: 'direct_tool:nearby_stores', total_ms: 40, usage: {llm_calls: 0}};
let ready;  // what GET /readyz answers: a body, or null for "unreachable"

test.beforeEach(async ({ page }) => {
  ready = {status: 'ready', checks: {config: 'ok', app_db: 'ok', client_db: 'ok', short_term_memory: 'ok'}};
  await page.setViewportSize({width: 1440, height: 900});
  await page.route(url => url.pathname.startsWith('/v1/') || ['/healthz', '/readyz'].includes(url.pathname), route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/healthz') return ready ? route.fulfill({headers: cors, json: {status: 'ok'}}) : route.abort();
    if (path === '/readyz') return ready ? route.fulfill({status: ready.status === 'ready' ? 200 : 503, headers: cors, json: ready}) : route.abort();
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token', expires_at: Date.now() / 1000 + 3600, user: {id: 'tabs-user', role: 'buyer', name: 'Tabs'}});
    await applySignedInUser();
  });
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
  await page.evaluate(() => {
    shoppingEnsureSession();
    window.finish = async (text, trace, source = 'text') => {
      const id = crypto.randomUUID();
      shoppingTurn(id, {userText: text, source});
      await shoppingTurnFinish(id, {status: 'answered', reply: 'ok', trace: structuredClone(trace), cards: []});
    };
    window.tableRows = node => [...node.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent));
  });
});

test('empty: every tab says there is nothing yet - no sample numbers', async ({ page }) => {
  const view = await page.evaluate(() => {
    panelShow('ai'); const ai = shopEl.aiLayerView.textContent;
    panelShow('trace'); const trace = shopEl.traceView.textContent;
    return {ai, trace, guard: shopEl.guardStatus.textContent};
  });
  expect(view.ai).toContain('No turns yet in this conversation.');
  expect(view.ai).toContain('No model calls reported yet.');
  expect(view.trace).toContain('No turns yet in this conversation.');
  expect(view.guard).toBe('No guardrail checks reported yet');
});

test('AI layer and Trace come from the turns: agents, models, tokens, latency and guardrail checks', async ({ page }) => {
  await page.evaluate(({ a, b }) => (async () => { await finish('add dolo 650', a); await finish('nearby pharmacies', b, 'voice'); })(),
    {a: TRACE, b: NEARBY});
  const view = await page.evaluate(() => {
    panelShow('ai');
    const tables = [...shopEl.aiLayerView.querySelectorAll('table')].map(tableRows);
    panelShow('trace');
    const trace = [...shopEl.traceView.querySelectorAll('table')].map(tableRows);
    return {agents: tables[0], models: tables[1], turns: trace[0], checks: trace[1], guard: shopEl.guardStatus.textContent,
      guardClass: shopEl.guardStatus.className};
  });
  expect(view.agents).toEqual([['commerce_agent', '1'], ['rules (direct tool)', '1']]);
  expect(view.models).toEqual([['gemini-flash', '1']]);
  expect(view.turns[0].slice(0, 2)).toEqual(['1', 'chat']);
  expect(view.turns[0][3]).toBe('commerce_agent');
  expect(view.turns[0][6]).toBe('1180 / 42');
  expect(view.turns[0][8]).toBe('2/2');
  expect(view.turns[1].slice(0, 2)).toEqual(['2', 'voice']);
  expect(view.turns[2][0]).toBe('2 turns');  // the totals row
  expect(view.turns[2][6]).toBe('1180 / 42');
  expect(view.checks).toEqual([['Pharmacy selection required', '0', '1', '0', '0'], ['Personal data masking', '1', '0', '0', '0']]);
  expect(view.guard).toBe('2 guardrail checks · 1 passed · 1 blocked');
  expect(view.guardClass).toContain('has-block');
});

test('Integration checks the API live and lists the tools actually used', async ({ page }) => {
  await page.evaluate(a => finish('add dolo 650', a), TRACE);
  await page.evaluate(() => panelShow('integration'));
  await expect.poll(() => page.evaluate(() => shopEl.integrationView.querySelectorAll('.integration-row').length)).toBe(5);
  const view = await page.evaluate(() => ({
    rows: [...shopEl.integrationView.querySelectorAll('.integration-row')].map(r => [r.querySelector('strong').textContent, r.querySelector('.guard-verdict').textContent]),
    tools: tableRows(shopEl.integrationView.querySelectorAll('table')[0]),
  }));
  expect(view.rows).toEqual([['API', 'ok'], ['Configuration', 'ok'], ["App database (this app's own state)", 'ok'],
    ['Client database (read-only business data)', 'ok'], ['Short-term memory (Redis)', 'ok']]);
  expect(view.tools).toEqual([['search_products', 'Core API', '1', 'catalog_items, stores']]);
});

test('Integration says the API is unreachable or degraded - never a green light it did not get', async ({ page }) => {
  ready = null;
  await page.evaluate(() => panelShow('integration'));
  await expect.poll(() => page.evaluate(() => shopEl.integrationView.querySelectorAll('.integration-row').length)).toBe(2);
  const down = await page.evaluate(() => [...shopEl.integrationView.querySelectorAll('.guard-verdict')].map(n => n.textContent));
  expect(down).toEqual(['unreachable', 'unreachable']);
  ready = {status: 'degraded', reason: 'database unreachable - long-term memory is disabled',
    checks: {config: 'ok', app_db: 'unreachable', client_db: 'ok', short_term_memory: 'ok'}};
  await page.evaluate(() => panelShow('integration'));
  await expect.poll(() => page.evaluate(() => shopEl.integrationView.textContent)).toContain('long-term memory is disabled');
  const degraded = await page.evaluate(() => [...shopEl.integrationView.querySelectorAll('.integration-row')]
    .map(r => [r.querySelector('strong').textContent, r.querySelector('.guard-verdict').textContent]));
  expect(degraded).toContainEqual(["App database (this app's own state)", 'unreachable']);
});

for (const [width, height] of [[1440, 900], [1920, 1080]]) {
  test(`desktop ${width}px: the inspector is about half the width, nothing overflows`, async ({ page }) => {
    await page.setViewportSize({width, height});
    const view = await page.evaluate(() => {
      const inspector = shopEl.activityPanel.getBoundingClientRect().width;
      const chat = document.querySelector('.card.chat-card').getBoundingClientRect().width;
      const doc = document.documentElement;
      return {share: inspector / (inspector + chat), overflow: doc.scrollWidth - doc.clientWidth};
    });
    expect(view.share).toBeGreaterThan(0.44);
    expect(view.share).toBeLessThan(0.51);
    expect(view.overflow).toBe(0);
  });
}

for (const [width, height] of [[768, 1024], [390, 844]]) {
  test(`${width}px: the inspector is a drawer, opened on demand, all six tabs reachable, no page overflow`, async ({ page }) => {
    await page.setViewportSize({width, height});
    const offscreen = () => page.evaluate(() => shopEl.activityPanel.getBoundingClientRect().top >= innerHeight - 1);
    await expect.poll(offscreen).toBe(true);
    await page.locator('#activityBtn').click();
    await expect.poll(offscreen).toBe(false);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.inspector .panel-tab')].filter(t => t.getBoundingClientRect().width > 0).length);
    expect(tabs).toBe(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
}
