// A request the browser cuts off because the page is being reloaded or left is not the pharmacy failing:
// no "Service is temporarily unavailable" notice is saved into the chat for it (live, 7 Oct: a reload
// aborted the shelf request and the next page showed "I couldn't connect to the pharmacy... I'll keep
// trying" while every service was healthy). A real failure is still said, truthfully.
const { test, expect } = require('@playwright/test');

let failCart = false;

test.beforeEach(async ({ page }) => {
  failCart = false;
  await page.route(url => url.pathname.startsWith('/v1/'), route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/v1/pharmacy/cart/') && failCart) return route.abort('failed');
    if (path.startsWith('/v1/pharmacy/cart/')) {
      return route.fulfill({json: {userId: 'reload-user', storeId: null, items: [], totalPaise: 0}});
    }
    if (path === '/v1/pharmacy/products') return route.fulfill({json: []});
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token', expires_at: Date.now() / 1000 + 3600, user: {id: 'reload-user', role: 'buyer', name: 'Reload'}});
    await applySignedInUser();
  });
  await page.waitForFunction(() => locEl.locationDialog.open);
  await page.evaluate(() => locationClose());
});

const notices = page => page.evaluate(() => [...shopEl.chatMessages.querySelectorAll('.chat-bubble')]
  .map(b => b.textContent).filter(t => /couldn't refresh your cart/i.test(t)));

test('a cart refresh cut off by a reload says nothing about the pharmacy', async ({ page }) => {
  expect(await notices(page)).toEqual([]);
  failCart = true;
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('pagehide'));  // the page is going away: in-flight requests are cut off
    shop.lastLoadError = null;
    await shoppingRefresh();
  });
  await page.waitForTimeout(500);
  expect(await notices(page)).toEqual([]);
});

test('a real cart failure is still said, truthfully', async ({ page }) => {
  failCart = true;
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('pageshow'));  // the page is here: a failure is a failure
    shop.lastLoadError = null;
    await shoppingRefresh();
  });
  await expect.poll(() => notices(page)).toContain("I couldn't refresh your cart. Service is temporarily unavailable. Please try again.");
});
