// The merchant overview and lists show what the API sends, in plain words, and say where it stops:
//  * today's own sales and completed orders lead the summary (dashboard.today), not repeated in the Today panel;
//  * the Today panel reads "All orders to date", "Today · Placed", the dashboard's alerts, and the day it is for;
//  * the periods are the API's own (readonly_services._period_start: midnight / Monday / the 1st, IST);
//  * the sidebar never names the store twice; a list cut at the API's limit says "Showing N of total";
//  * an unpaid order and a prescription-only item say so.
// The page's own code runs; only the API is stood in for - the figures are test values.
const { test, expect } = require('@playwright/test');

const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'};
const DATA = {
  dashboard: {store: {name: 'Test Pharmacy', category: 'pharmacy', status: 'OPEN', isOpen: true},
    today: {date: '2026-10-12', revenuePaise: 123450, fulfilledOrders: 7, ordersByStatus: {PLACED: 2}},
    orders: {total: 90}, alerts: [{kind: 'low_stock', count: 3}], recentOrders: []},
  earnings: {today: {orders: 7, grossPaise: 123450, netPayoutPaise: 111105}, week: {orders: 20, grossPaise: 400000, netPayoutPaise: 360000},
    month: {orders: 60, grossPaise: 1200000, netPayoutPaise: 1080000}, settlements: {count: 2, settledPaise: 500000}},
  orders: {data: [
    {number: 'ORD-2', status: 'PACKING', paymentStatus: 'PENDING', paymentMethod: 'COD', items: 2, totalPaise: 30950, payoutPaise: 27855, at: '2026-10-12T09:30:00+05:30'},
    {number: 'ORD-1', status: 'DELIVERED', paymentStatus: 'PAID', paymentMethod: 'UPI', items: 1, totalPaise: 12000, payoutPaise: 10800, at: '2026-10-12T09:00:00+05:30'},
    // Cancelled before payment (local client data, 12 Oct: "Cancelled · Payment pending" read as money owed).
    {number: 'ORD-0', status: 'CANCELLED', paymentStatus: 'PENDING', paymentMethod: 'COD', items: 1, totalPaise: 7200, payoutPaise: 0, at: '2026-10-12T08:00:00+05:30'}],
    meta: {total: 90}},
  'top-items': {window: 'week', items: []},
  'low-stock': {data: [{id: 'i1', name: 'Test antibiotic', category: 'Antibiotic', brand: null, stockStatus: 'LOW_STOCK', qty: 3,
    lowStockThreshold: 10, pricePaise: 9800, mrpPaise: 11000, expiryDate: null, prescriptionRequired: true}], meta: {total: 1}},
  catalog: {totalItems: 40, outOfStockItems: 0},
};

async function openAsMerchant(page) {
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/auth/me') return route.fulfill({headers: cors, json: {id: 'm-1', name: 'Test Pharmacy', email: 'owner@example.test', role: 'merchant'}});
    if (path === '/v1/merchant/me/stores') return route.fulfill({headers: cors, json: {stores: [{id: 's1', name: 'Test Pharmacy', isOpen: true}]}});
    if (path.startsWith('/v1/merchant/')) {
      const section = path.split('/').pop();
      return route.fulfill({headers: cors, json: {section, tool: 't', data: DATA[section] || {}}});
    }
    return route.fulfill({headers: cors, json: {}});
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    authSave({access_token: 'token-m', expires_at: Date.now() / 1000 + 3600,
              user: {id: 'm-1', role: 'merchant', name: 'Test Pharmacy', email: 'owner@example.test'}});
    await applySignedInUser();
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  });
}

test('the overview leads with today\'s own figures and labels the rest in plain words', async ({ page }) => {
  await openAsMerchant(page);
  const tiles = page.locator('.m-tile');
  await expect(tiles.first()).toContainText('Sales today');
  await expect(tiles.first()).toContainText('₹1,234.50');
  await expect(tiles.nth(1)).toContainText('Orders completed today');
  await expect(tiles.nth(1)).toContainText('7');

  const today = page.locator('.m-panel').filter({has: page.getByRole('heading', {name: 'Today'})});
  await expect(today).toContainText('All orders to date');
  await expect(today).toContainText('Today · Placed');
  await expect(today).toContainText('Alert · Low stock');
  await expect(today).toContainText('For 12 Oct 2026 (IST).');
  await expect(today).not.toContainText('Sales today');           // the tile says it
  await expect(today).not.toContainText('ORD-');                  // the Recent orders panel's, not repeated

  const earnings = page.locator('.m-panel').filter({has: page.getByRole('heading', {name: 'Earnings'})});
  await expect(earnings).toContainText('Today is from midnight, this week from Monday, this month from the 1st (IST).');
  await expect(earnings).toContainText('Settlements paid');
  await expect(earnings).toContainText('Amount settled');

  await expect(page.locator('#merchantName')).toHaveText('Test Pharmacy');
  await expect(page.locator('#merchantIdLine')).toHaveText('owner@example.test');   // not the store name again
});

test('a list cut at the API\'s limit says how many there are; unpaid and prescription-only rows say so', async ({ page }) => {
  await openAsMerchant(page);
  await page.locator('[data-mview="orders"]').click();
  const body = page.locator('#merchantBody');
  await expect(body).toContainText('Showing the latest 3 of 90 orders');
  const cancelled = body.locator('.m-row').filter({hasText: 'ORD-0'});
  await expect(cancelled).toContainText('Cancelled');
  await expect(cancelled).not.toContainText('Payment');            // nothing to pay on a cancelled order
  const unpaid = body.locator('.m-row').filter({hasText: 'ORD-2'});
  await expect(unpaid).toContainText('Payment pending');
  await expect(unpaid).toContainText('Items: 2');
  await expect(body.locator('.m-row').filter({hasText: 'ORD-1'})).not.toContainText('Payment');

  await page.locator('[data-mview="low-stock"]').click();
  const row = body.locator('.m-row').filter({hasText: 'Test antibiotic'});
  await expect(row).toContainText('Qty: 3 (alert at 10)');
  await expect(row).toContainText('Rx required');
  await expect(body).not.toContainText('Showing');                 // all of them are shown
});
