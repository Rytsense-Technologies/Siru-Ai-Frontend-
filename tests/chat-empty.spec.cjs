// An empty customer conversation shows what Siru can do and questions to start with - a page element, never a chat
// message (the chat still opens empty: no typed greeting). A suggestion is sent as the user's own turn, exactly as if
// typed; the empty state is gone as soon as the conversation has anything in it, and back for a new sign-in.
// The page's own code runs; only the API is stood in for.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'};

test('an empty conversation offers questions; one sends that question as the user\'s turn and the empty state goes', async ({ page }) => {
  const turns = [];
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), p = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (p === '/v1/auth/me') return route.fulfill({headers: cors, json: {id: 'buyer-1', name: 'Test Buyer', role: 'buyer'}});
    // The pharmacy the page connects to (otherwise it says so in the chat - and the conversation is not empty).
    if (p === '/v1/pharmacy/stores/nearby') return route.fulfill({headers: cors, json: {stores: []}});
    if (p === '/v1/pharmacy/products') return route.fulfill({headers: cors, json: []});
    if (/^\/v1\/pharmacy\/cart\/[^/]+$/.test(p)) return route.fulfill({headers: cors, json: {items: [], storeId: null}});
    if (p === '/v1/memory/me') return route.fulfill({headers: cors, json: {facts: []}});
    if (p === '/v1/concierge/turn') {
      turns.push(request.postDataJSON());
      const events = [{type: 'text', text: "You haven't placed any orders yet."},
        {type: 'turn_end', trace: {agent: 'commerce_agent', steps: []}, trace_id: 't-1'}, {type: 'done'}];
      return route.fulfill({status: 200, headers: {...cors, 'Content-Type': 'text/event-stream'},
        body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')});
    }
    return route.fulfill({status: 404, headers: cors, json: {detail: 'Not Found'}});
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await expect(page.locator('#chatEmpty')).toBeHidden();             // nobody signed in
  await page.evaluate(async () => {
    authSave({access_token: 'token-b', expires_at: Date.now() / 1000 + 3600, user: {id: 'buyer-1', role: 'buyer', name: 'Test Buyer'}});
    await applySignedInUser();
  });
  for (const dialog of await page.locator('dialog[open]').all()) await dialog.press('Escape');

  const empty = page.locator('#chatEmpty');
  await expect(empty).toBeVisible();
  await expect(page.locator('#chatMessages')).toBeEmpty();           // not a chat message
  const chips = empty.getByRole('button');
  await expect(chips).toHaveText(['Do you have Dolo 650?', 'Show my last order', 'What do you remember about me?',
    'How do I upload a prescription?']);

  // The first sign-in asks for a location before anything else: the page's own save, as a choice in it would.
  const locationDialog = page.locator('#locationDialog');
  await locationDialog.waitFor({state: 'visible', timeout: 3000}).catch(() => {});
  await page.evaluate(() => {
    locationSave({source: 'device', lat: 13.0418, lng: 80.2341, accuracy: 20, label: 'Current location'});
    document.getElementById('locationDialog').close();
  });
  await expect(locationDialog).toBeHidden();
  await empty.getByRole('button', {name: 'Show my last order'}).click();
  await expect.poll(() => turns.length).toBe(1);
  expect(JSON.stringify(turns[0])).toContain('Show my last order');
  await expect(page.locator('#chatMessages')).toContainText('Show my last order');
  await expect(page.locator('#chatMessages')).toContainText("You haven't placed any orders yet.");
  await expect(empty).toBeHidden();

  // A new conversation for the next sign-in opens empty again - with the questions.
  await page.evaluate(async () => {
    authSave({access_token: 'token-c', expires_at: Date.now() / 1000 + 3600, user: {id: 'buyer-2', role: 'buyer', name: 'Other'}});
    await applySignedInUser();
  });
  await expect(page.locator('#chatMessages')).toBeEmpty();
  await expect(empty).toBeVisible();
});
