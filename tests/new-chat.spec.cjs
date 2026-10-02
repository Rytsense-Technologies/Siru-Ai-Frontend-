// "New chat" (shopping.js shoppingNewChat): a fresh conversation without
// signing out - a new conversation id (sent with every mic session of it, so
// the voice greeting and the pharmacy choice are per conversation), the chat
// and the inspector start empty, the server drops the old conversation's
// pending answers (POST /v1/concierge/conversation/new), and nothing that is
// the user's - memory, household, cart, orders - is deleted. Only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, PATCH, OPTIONS'};
let calls;

test.beforeEach(async ({ page }) => {
  calls = [];
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    calls.push(`${request.method()} ${path}`);
    if (path === '/v1/concierge/conversation/new') {
      return route.fulfill({headers: cors, json: {cleared: {pharmacy_list: true}}});
    }
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token-a', expires_at: Date.now() / 1000 + 3600, user: {id: 'chat-a', role: 'buyer', name: 'A'}});
    await applySignedInUser();
  });
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
  await page.evaluate(async () => {
    shoppingEnsureSession();
    const id = crypto.randomUUID();
    shoppingTurn(id, {userText: 'show nearby pharmacies', source: 'text'});
    await shoppingTurnFinish(id, {status: 'answered', reply: 'The nearest open pharmacy is Alpha Pharmacy.', cards: [],
      trace: {steps: [{id: 1, kind: 'tool', name: 'find_nearby_pharmacies', by: 'direct', status: 'done', at_ms: 1}],
        io: {calls: [], checkpoints: [], data: []}, agent: 'direct_tool:nearby_stores', total_ms: 3, usage: {llm_calls: 0}}});
  });
});

test('a new chat is a new conversation id, empty, and the old one is never reused', async ({ page }) => {
  const before = await page.evaluate(() => ({id: shoppingSessionId, chat: shopEl.chatMessages.textContent,
    requests: shopEl.inspectorSub.textContent}));
  expect(before.chat).toContain('show nearby pharmacies');
  expect(before.requests).toContain('1 request');
  await page.locator('#newChatBtn').click();
  await expect.poll(() => page.evaluate(() => shoppingSessionId)).not.toBe(before.id);
  const after = await page.evaluate(() => ({
    id: shoppingSessionId, chat: shopEl.chatMessages.textContent, requests: shopEl.inspectorSub.textContent,
    history: JSON.stringify(userHistory(getUserId())), user: getUserId(),
    // Every mic session of this conversation sends this id (app.js sessionQuery).
    query1: buyerVoiceSurface.sessionQuery(), query2: buyerVoiceSurface.sessionQuery(),
  }));
  expect(after.user).toBe('chat-a');  // still signed in
  expect(after.chat).not.toContain('show nearby pharmacies');
  expect(after.history).not.toContain('show nearby pharmacies');
  expect(after.requests).toBe('No requests yet in this conversation');
  expect(after.query1).toBe(`&chat_session_id=${encodeURIComponent(after.id)}`);
  expect(after.query2).toBe(after.query1);
  expect(after.query1).not.toContain(before.id);
  // The server dropped the old conversation's pending answers - once; nothing of the user's was deleted.
  expect(calls.filter(c => c === 'POST /v1/concierge/conversation/new')).toHaveLength(1);
  expect(calls.filter(c => c.startsWith('DELETE '))).toEqual([]);
});

test('a new chat whose server call fails still starts fresh and says the old questions may stand', async ({ page }) => {
  await page.unroute(url => url.pathname.startsWith('/v1/'));
  await page.route(url => url.pathname.startsWith('/v1/'), route => route.request().method() === 'OPTIONS'
    ? route.fulfill({status: 204, headers: cors}) : route.abort());
  const before = await page.evaluate(() => shoppingSessionId);
  await page.locator('#newChatBtn').click();
  await expect.poll(() => page.evaluate(() => shoppingSessionId)).not.toBe(before);
  await expect.poll(() => page.evaluate(() => shopEl.chatMessages.textContent))
    .toContain("couldn't be reached to clear the last conversation's pending questions");
});
