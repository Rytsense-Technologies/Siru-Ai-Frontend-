// Catalog values are DATA: a product name, id or image address from the client
// catalog must never run script, add markup or break out of an attribute -
// checked in a real browser, on the real render functions, under the page's
// real Content-Security-Policy.
const { test, expect } = require('@playwright/test');

const PAYLOADS = [
  'Dolo "650" <b>bold</b>',
  "Crocin's \"quoted\" name",
  '"><img src=x onerror="window.__pwned++">',
  "'><svg onload='window.__pwned++'>",
  '<script>window.__pwned++</script>',
  'Amp & ersand > greater < less',
  'Back`tick`${window.__pwned++}',
  'Line\nbreak\r\nname',
  '" autofocus onfocus="window.__pwned++" x="',
];
const BAD_IMAGES = [
  'javascript:window.__pwned++',
  ' JaVaScRiPt:window.__pwned++',
  'data:text/html,<script>window.__pwned++</script>',
  'data:image/svg+xml,<svg onload="window.__pwned++"/>',
  'vbscript:msgbox(1)',
  'x" onerror="window.__pwned++',
  'http://user:pass@evil.example/a.png',
  'http://[not-a-url',
  '\u0000javascript:alert(1)',
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__pwned = 0;
    window.__csp = [];
    window.alert = window.confirm = window.prompt = () => { window.__pwned++; };
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
});

test('the page loads under its CSP with the pinned LiveKit client', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const response = await page.goto('/index.html');
  const csp = response.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  await page.waitForLoadState('load');
  expect(await page.evaluate(() => typeof window.LivekitClient?.Room)).toBe('function');
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(errors).toEqual([]);
});

test('escapeHtml and safeImageUrl are context-correct', async ({ page }) => {
  await page.goto('/index.html');
  const result = await page.evaluate(({ payloads, bad }) => ({
    escaped: payloads.map(p => escapeHtml(p)),
    images: bad.map(u => safeImageUrl(u)),
    good: [safeImageUrl('https://cdn.example.com/a.png'), safeImageUrl('images/medicine.svg')],
    fallback: safeImageUrl('images/medicine.svg'),
  }), { payloads: PAYLOADS, bad: BAD_IMAGES });
  for (const text of result.escaped) expect(text).not.toMatch(/[<>"'`]/);
  for (const url of result.images) expect(url).toBe('images/medicine.svg');  // the placeholder, as given
  expect(result.good[0]).toBe('https://cdn.example.com/a.png');
  expect(result.good[1]).toMatch(/\/images\/medicine\.svg$/);
});

test('malicious catalog names, ids and image URLs render as inert text', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  const products = PAYLOADS.map((name, i) => ({
    id: `id-${i}" onclick="window.__pwned++`, name, pack_size: `<i>${i}</i>`, price_paise: 3100 + i,
    image_url: BAD_IMAGES[i % BAD_IMAGES.length],
  }));
  const cart = {
    version: 1_000_000, total_paise: 9999,
    items: products.map((p, i) => ({ id: p.id, name: p.name, pack_size: p.pack_size, qty: 1 + i, price_paise: p.price_paise,
      line_total_paise: p.price_paise * (1 + i), image_url: p.image_url })),
  };
  const dom = await page.evaluate(({ products, cart }) => {
    shop.products = products;
    shoppingRenderProducts();
    shoppingRenderCart(cart);
    const roots = [shopEl.medicineList, shopEl.cartItems];
    const all = roots.flatMap(r => [...r.querySelectorAll('*')]);
    return {
      handlerAttrs: all.flatMap(n => [...n.attributes].filter(a => /^on/i.test(a.name)).map(a => `${n.tagName} ${a.name}`)),
      injected: roots.map(r => r.querySelectorAll('script, iframe, object, embed, b, i, svg:not(.icon-svg)').length),
      productNames: [...shopEl.medicineList.querySelectorAll('.medicine-card strong')].map(n => n.textContent),
      cartNames: [...shopEl.cartItems.querySelectorAll('.cart-item-info strong')].map(n => n.textContent),
      titles: [...shopEl.cartItems.querySelectorAll('.cart-item-info strong')].map(n => n.getAttribute('title')),
      ids: [...shopEl.medicineList.querySelectorAll('.medicine-card')].map(n => n.dataset.id),
      removeIds: [...shopEl.cartItems.querySelectorAll('.remove-product')].map(n => n.dataset.id),
      images: [...roots[0].querySelectorAll('img'), ...roots[1].querySelectorAll('img')].map(n => n.getAttribute('src')),
      packs: [...shopEl.medicineList.querySelectorAll('.select-product .muted')].map(n => n.textContent),
    };
  }, { products, cart });
  await page.waitForTimeout(500);  // any onerror/onload/autofocus would have fired by now
  expect(await page.evaluate(() => window.__pwned)).toBe(0);
  expect(dom.handlerAttrs).toEqual([]);
  expect(dom.injected).toEqual([0, 0]);
  const names = PAYLOADS.map(p => p);
  expect(dom.productNames).toEqual(names);
  expect(dom.cartNames).toEqual(names);
  expect(dom.titles).toEqual(names);
  expect(dom.ids).toEqual(products.map(p => p.id));
  expect(dom.removeIds).toEqual(products.map(p => p.id));
  expect(dom.packs).toEqual(products.map(p => p.pack_size));
  for (const src of dom.images) expect(src).toMatch(/(^|\/)images\/medicine\.svg$/);
});
