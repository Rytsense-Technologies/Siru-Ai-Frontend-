// The inspector is half the screen beside the chat, each scrolling on its own,
// and its Tool calls / Data / Memory / AI layer views follow the selected turn
// - showing only what that turn's trace reported (shopping.js inspectorSelect).
const { test, expect } = require('@playwright/test');

// A turn as the server traces it (multi_agent_framework/tracing.py, the SSE io).
const TRACE = {
  steps: [
    {id: 1, kind: 'route', name: 'pre_router', next: 'commerce_agent', intent: 'add_to_cart', at_ms: 2, duration_ms: 3},
    {id: 2, kind: 'agent', name: 'commerce_agent', status: 'done', at_ms: 6, ended_at_ms: 940, duration_ms: 934},
    {id: 3, kind: 'llm', name: 'openai:gpt-4.1-mini', status: 'done', tool_calls: ['search_products'], at_ms: 10, duration_ms: 410, tokens_in: 1180, tokens_out: 42},
    {id: 4, kind: 'tool', name: 'search_products', by: 'model', status: 'done', at_ms: 425, duration_ms: 126, input: {query: 'dolo 650'}, result_count: 3},
    {id: 5, kind: 'tool', name: 'add_to_cart', by: 'model', status: 'done', at_ms: 560, duration_ms: 58},
    {id: 6, kind: 'memory', name: 'short-term saved', store: 'redis', status: 'done', count: 2, at_ms: 945},
  ],
  io: {calls: [
    {name: 'search_products', plane: 'core', tables_read: ['catalog_items', 'stores'], tables_written: []},
    {name: 'add_to_cart', plane: 'core', tables_read: ['carts'], tables_written: ['cart_items']},
  ], checkpoints: [], data: []},
  agent: 'commerce_agent', total_ms: 950, usage: {llm_calls: 1, tokens_in: 1180, tokens_out: 42, by_model: {'openai:gpt-4.1-mini': {calls: 1}}},
};
const GREETING = {steps: [{id: 1, kind: 'route', name: 'fast_path', next: 'end', at_ms: 1, duration_ms: 2}],
  io: {calls: [], checkpoints: [], data: []}, agent: 'supervisor', total_ms: 4, usage: {llm_calls: 0}};

// Uncaught errors in the page fail the test (refused API calls are expected: there is no backend).
let pageErrors = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewportSize({width: 1440, height: 900});
  await page.route(url => url.pathname.startsWith('/v1/'), route => route.abort());
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  // Signed in as the page does it (user-menu.js), so the app view is shown.
  await page.evaluate(async () => {
    authSave({access_token: 'token', expires_at: Date.now() / 1000 + 3600, user: {id: 'inspector-user', role: 'buyer', name: 'Inspector'}});
    await applySignedInUser();
  });
  // No saved location: sign-in asks for one (location-ui.js locationStart). Dismiss it, as a user would.
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
  await page.evaluate(async ({ trace, greeting }) => {
    shoppingEnsureSession();
    window.turnIds = [];
    for (const [text, data] of [['need to add dolo 650', trace], ['hi', greeting]]) {
      const id = crypto.randomUUID();
      turnIds.push(id);
      shoppingTurn(id, {userText: text, source: 'text'});
      await shoppingTurnFinish(id, {status: 'answered', reply: `reply to ${text}`, trace: structuredClone(data), cards: []});
    }
  }, { trace: TRACE, greeting: GREETING });
});

test('chat and inspector split the desktop in half', async ({ page }) => {
  const widths = await page.evaluate(() => [document.querySelector('.card.chat-card'), shopEl.activityPanel]
    .map(node => node.getBoundingClientRect().width));
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(2);
  expect(widths[1]).toBeGreaterThan(600);
});

test('the latest turn is selected, with empty states for what it did not do', async ({ page }) => {
  const view = await page.evaluate(() => ({
    bar: shopEl.inspectorTurn.textContent, data: shopEl.turnData.textContent,
    memory: shopEl.turnMemory.textContent, ai: shopEl.turnAi.textContent,
    noTools: shopEl.activityList.querySelector(`[data-turn-id="${turnIds[1]}"]`).textContent,
  }));
  expect(view.bar).toContain('Turn 2 of 2');
  expect(view.bar).toContain('“hi”');
  expect(view.data).toContain('No data read or written in this turn.');
  expect(view.memory).toContain('No memory read or written in this turn.');
  expect(view.ai).toContain('Fast path');
  expect(view.noTools).toContain('No tool calls for this turn.');
});

test("selecting a chat turn shows that turn's tools, data, memory and AI layer", async ({ page }) => {
  await page.locator(`.chat-turn[data-turn-id]`).first().locator('.chat-bubble.user').click();
  const view = await page.evaluate(() => {
    const card = shopEl.activityList.querySelector(`[data-turn-id="${turnIds[0]}"]`);
    return {
      bar: shopEl.inspectorTurn.textContent,
      cardOpen: card.open, cardSelected: card.classList.contains('selected'),
      labels: [...card.querySelectorAll('.trace-row .trace-label')].map(n => n.textContent),
      tools: [...card.querySelectorAll('.trace-row')].filter(r => r.querySelector('.trace-label').textContent === 'TOOL')
        .map(r => r.querySelector('.trace-name').textContent),
      toolDetail: card.querySelector('.trace-row:nth-child(4) .trace-detail')?.textContent,
      data: [...shopEl.turnData.querySelectorAll('.data-row')].map(r => r.textContent),
      memory: shopEl.turnMemory.textContent,
      ai: [...shopEl.turnAi.querySelectorAll('.trace-label')].map(n => n.textContent),
    };
  });
  expect(view.bar).toContain('Turn 1 of 2');
  expect(view.cardOpen).toBe(true);
  expect(view.cardSelected).toBe(true);
  // The lifecycle in order: route, agent, model, the tools chronologically, memory, the reply.
  expect(view.labels).toEqual(['ROUTE', 'AGENT', 'MODEL', 'TOOL', 'TOOL', 'MEMORY', 'OUT']);
  expect(view.tools).toEqual(['search_products', 'add_to_cart']);
  expect(view.toolDetail).toContain('in commerce_agent');
  expect(view.data.find(r => r.startsWith('cart_items'))).toContain('W 1');
  expect(view.data.find(r => r.startsWith('catalog_items'))).toContain('R 1');
  expect(view.memory).toContain('short-term saved');
  expect(view.ai).toEqual(['ROUTE', 'AGENT', 'MODEL']);
});

test('the chat and the inspector scroll independently', async ({ page }) => {
  const result = await page.evaluate(async ({ greeting }) => {
    for (let i = 0; i < 10; i++) {
      const id = crypto.randomUUID();
      shoppingTurn(id, {userText: `question ${i}`, source: 'text'});
      await shoppingTurnFinish(id, {status: 'answered', reply: `answer ${i}`, trace: structuredClone(greeting)});
    }
    const chat = shopEl.chatMessages, tools = shopEl.toolsTab;
    chat.scrollTop = 0; tools.scrollTop = 0;
    tools.scrollTop = 300;
    const chatAfterInspector = chat.scrollTop;
    chat.scrollTop = 200;
    return {overflow: chat.scrollHeight > chat.clientHeight && tools.scrollHeight > tools.clientHeight,
      chatAfterInspector, inspectorAfterChat: tools.scrollTop, page: scrollY};
  }, { greeting: GREETING });
  expect(result.overflow).toBe(true);
  expect(result.chatAfterInspector).toBe(0);
  expect(result.inspectorAfterChat).toBe(300);
  expect(result.page).toBe(0);
});

test('on a phone the inspector is a drawer: closed until asked, closed by its X', async ({ page }) => {
  await page.setViewportSize({width: 375, height: 812});
  const offscreen = () => page.evaluate(() => shopEl.activityPanel.getBoundingClientRect().top >= innerHeight - 1);
  await expect.poll(offscreen).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#activityBtn').click();
  await expect.poll(offscreen).toBe(false);
  await page.locator('#activityClose').click();
  await expect.poll(offscreen).toBe(true);
  // A new turn updates the inspector without opening the drawer over the chat.
  await page.evaluate(async ({ greeting }) => {
    const id = crypto.randomUUID();
    shoppingTurn(id, {userText: 'phone question', source: 'text'});
    await shoppingTurnFinish(id, {status: 'answered', reply: 'phone answer', trace: structuredClone(greeting)});
  }, { greeting: GREETING });
  expect(await page.evaluate(() => shopEl.inspectorTurn.textContent)).toContain('“phone question”');
  await page.waitForTimeout(400);  // the drawer's transition, had it opened
  expect(await offscreen()).toBe(true);
});

test('long unbroken values wrap inside their cards, never widening the chat or the inspector', async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 900});
    const result = await page.evaluate(async () => {
      const long = 'Unbroken'.repeat(30);
      const id = crypto.randomUUID();
      shoppingTurn(id, {userText: long, source: 'text'});
      await shoppingTurnFinish(id, {status: 'answered', reply: long, cards: [
        {kind: 'pharmacy_offer', pharmacy: {name: long, distanceKm: 1, etaMin: 20}, product: {name: long, inStock: true}, note: long},
        {kind: 'confirm_action', actionId: 'a1', title: 'Place this order', rows: [{label: 'Deliver to', value: long}]},
        {kind: 'choices', question: 'Which one?', options: [{label: long, value: 'x'}]},
      ], trace: {steps: [{id: 1, kind: 'tool', name: 'search_products', status: 'error', at_ms: 1}], failed: true, error: long,
        io: {calls: [{name: 'search_products', plane: 'core', tables_read: [long], tables_written: []}]}, trace_id: long, total_ms: 1, usage: {llm_calls: 0}}});
      document.querySelectorAll('.inspector .agent-activity').forEach(d => d.open = true);
      const tabs = {};
      for (const tab of ['tools', 'data']) {
        panelShow(tab);
        const box = shopEl[`${tab}Tab`];
        tabs[tab] = box.scrollWidth - box.clientWidth;
      }
      const chat = shopEl.chatMessages;
      // clientWidth, not innerWidth: a headed window's scrollbar is not page overflow.
      const doc = document.documentElement;
      return {page: doc.scrollWidth - doc.clientWidth, chat: chat.scrollWidth - chat.clientWidth, ...tabs};
    });
    expect(result, `at ${width}px`).toEqual({page: 0, chat: 0, tools: 0, data: 0});
  }
});

test('a reply arriving while the reader is on an earlier turn does not move the chat', async ({ page }) => {
  const result = await page.evaluate(async ({ greeting }) => {
    for (let i = 0; i < 12; i++) {
      const id = crypto.randomUUID();
      shoppingTurn(id, {userText: `question ${i}`, source: 'text'});
      await shoppingTurnFinish(id, {status: 'answered', reply: `answer ${i}`, trace: structuredClone(greeting)});
    }
    const box = shopEl.chatMessages;
    const settle = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 20)));
    const id = crypto.randomUUID();
    shoppingTurn(id, {userText: 'a new question', source: 'text'});
    await settle();
    const ownAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 5;
    box.scrollTop = 0;  // the reader goes back to an earlier turn
    await settle();
    await shoppingTurnFinish(id, {status: 'answered', reply: 'the answer', trace: structuredClone(greeting)});
    shoppingMessage('a notice', 'assistant', 'text');
    await settle();
    const stayed = box.scrollTop === 0;
    box.scrollTop = box.scrollHeight;  // back at the newest message: new content follows
    await settle();
    shoppingMessage('another notice', 'assistant', 'text');
    await settle();
    return {ownAtBottom, stayed, follows: box.scrollHeight - box.scrollTop - box.clientHeight < 5};
  }, { greeting: GREETING });
  expect(result).toEqual({ownAtBottom: true, stayed: true, follows: true});
});

test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});
