// The Inspector's Guardrails section lists the guard steps this conversation's
// traces reported (multi_agent_framework/tracing.py, kind "guard") - each with
// its decision and the short reason given - and nothing it wasn't told: no
// guard step, no section; a turn that succeeded is not shown as a "pass".
const { test, expect } = require('@playwright/test');

const turn = steps => ({steps, io: {calls: [], checkpoints: [], data: []}, agent: 'direct_tool:add_product',
  total_ms: 12, usage: {llm_calls: 0}});

test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname.startsWith('/v1/'), route => route.abort());
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token', expires_at: Date.now() / 1000 + 3600, user: {id: 'guard-user', role: 'buyer', name: 'Guard'}});
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
    window.guardView = () => ({
      hidden: shopEl.guardrails.hidden, count: shopEl.guardCount.textContent, blocked: shopEl.guardBlocked.textContent,
      rows: [...shopEl.guardList.querySelectorAll('.guard-row')].map(row => ({
        name: row.querySelector('.guard-head strong').textContent,
        verdict: row.querySelector('.guard-verdict').textContent,
        tone: [...row.classList].find(c => c.startsWith('guard-') && c !== 'guard-row'),
        meta: row.querySelector('.guard-meta').textContent,
        detail: row.querySelector('.guard-detail')?.textContent || '',
      })),
    });
  });
});

test('no guard step reported: no Guardrails section, and a successful turn is not a "pass"', async ({ page }) => {
  await page.evaluate(() => finish('add dolo 650', {steps: [{id: 1, kind: 'tool', name: 'add_to_cart', by: 'direct', status: 'done', at_ms: 3}],
    io: {calls: [], checkpoints: [], data: []}, agent: 'direct_tool:add_product', total_ms: 5, usage: {llm_calls: 0}}));
  expect(await page.evaluate(() => guardView())).toMatchObject({hidden: true, count: '0', rows: []});
});

test('each traced guard is listed with its decision and reason, newest first; blocks are counted', async ({ page }) => {
  await page.evaluate(({ a, b }) => (async () => { await finish('add dolo 650', a); await finish('what dose of dolo', b, 'voice'); })(), {
    a: turn([{id: 1, kind: 'guard', name: 'pharmacy_selection', verdict: 'required', detail: 'no pharmacy chosen in this conversation', at_ms: 4}]),
    b: turn([{id: 1, kind: 'guard', name: 'dose_lock', verdict: 'answered_pinned', at_ms: 2},
      {id: 2, kind: 'guard', name: 'cart_guard', verdict: 'blocked', detail: 'dose_question', at_ms: 6}]),
  });
  const view = await page.evaluate(() => guardView());
  expect(view.hidden).toBe(false);
  expect(view.count).toBe('3');
  expect(view.blocked).toBe('2 blocked');
  expect(view.rows.map(r => [r.name, r.verdict, r.tone])).toEqual([
    ['Cart guard', 'blocked', 'guard-block'],
    ['Dose lock', 'answered_pinned', 'guard-note'],
    ['Pharmacy selection required', 'required', 'guard-block'],
  ]);
  expect(view.rows[0].meta).toContain('Turn 2');
  expect(view.rows[0].meta).toContain('voice');
  expect(view.rows[0].detail).toBe('dose_question');
  expect(view.rows[2].meta).toContain('Turn 1');
});

test('another user never sees this user\'s guardrails', async ({ page }) => {
  await page.evaluate((a) => finish('add dolo 650', a),
    turn([{id: 1, kind: 'guard', name: 'allergy_check', verdict: 'blocked', at_ms: 4}]));
  expect((await page.evaluate(() => guardView())).count).toBe('1');
  const other = await page.evaluate(async () => {
    authSave({access_token: 'token-b', expires_at: Date.now() / 1000 + 3600, user: {id: 'guard-user-b', role: 'buyer', name: 'B'}});
    await applySignedInUser();
    return guardView();
  });
  expect(other).toMatchObject({hidden: true, count: '0', rows: []});
});
