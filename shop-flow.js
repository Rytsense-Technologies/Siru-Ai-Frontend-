// Nearby pharmacy -> medicines -> checkout, without the chat and without any
// model call: every step is a direct API call and deterministic code.
//
//   1. pharmacies  the ACTIVE location's own coordinates (location.js: the
//                  device's, or the typed address the user confirmed on the map;
//                  never a default city, never (0,0), and never the device's GPS
//                  read behind a typed address) -> GET /v1/pharmacy/stores/nearby
//                  -> the 5 nearest open pharmacies, nearest first (measured
//                  server-side from provider.stores' own coordinates)
//   2. medicines   the selected pharmacy's own shelf (GET /v1/pharmacy/products
//                  ?store_id=), searched locally; + / - go to the server cart
//   3. checkout    address, pharmacy, items, the server's bill, payment method
//                  (none pre-selected) -> POST /v1/actions/orders -> confirm
//   4. result      the order number the server returned, or its error
//
// Pharmacies (per rounded location) and a pharmacy's shelf are fetched once
// and reused; search never hits the network. A new location: the list is
// measured again, and a pharmacy picked from the old one is let go.

const shopFlowEl = {
  dialog: document.getElementById('shopDialog'),
  title: document.getElementById('shopTitle'),
  sub: document.getElementById('shopSub'),
  back: document.getElementById('shopBackBtn'),
  body: document.getElementById('shopBody'),
  foot: document.getElementById('shopFoot'),
};

const SHOP_FLOW_NEAREST = 5;
const shopFlow = {
  step: 'pharmacies',
  owner: null,           // the user this flow's choices belong to
  pharmacy: null,        // {id, name, distanceKm, area, address, etaMin}
  payment: null,         // 'cod' | 'upi' | 'card' - the user's explicit choice
  placing: false,
  query: '',
  storesCache: new Map(),   // "lat,lng" -> stores
  shelfCache: new Map(),    // storeId -> products
  confirmSwitch: null,      // {product, qty} awaiting "Switch pharmacy"
  notice: null,             // shown once at the top of the next checkout (a price changed)
  seq: 0,
};

function shopFlowCoords() {
  const place = siruLocation.place;
  return place && place.lat != null && place.lng != null && locationValidCoords(place.lat, place.lng)
    ? {lat: place.lat, lng: place.lng}
    : null;
}

// Where the list is measured from, said under its title.
function shopFlowOrigin() {
  const place = siruLocation.place;
  if (!place) return '';
  const {title, line} = locationDescribe(place);
  return place.source === 'device' ? 'Measured from your current location' : `Measured from ${title}: ${line}`;
}

function shopFlowHeader(title, sub = '', canGoBack = false) {
  shopFlowEl.title.textContent = title;
  shopFlowEl.sub.textContent = sub;
  shopFlowEl.back.hidden = !canGoBack;
}

function shopFlowButton(text, onClick, className = 'shop-btn') {
  const button = el_('button', className, text);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function shopFlowMessage(title, lines = [], actions = []) {
  const box = el_('div', 'shop-message');
  box.append(el_('strong', '', title));
  for (const line of lines) box.append(el_('p', 'muted small', line));
  if (actions.length) {
    const row = el_('div', 'shop-actions');
    row.append(...actions);
    box.append(row);
  }
  shopFlowEl.body.replaceChildren(box);
}

function shopFlowCartLine(itemId) {
  return shop.cart?.items.find(i => i.id === itemId) || null;
}

function shopFlowCartSummary() {
  const cart = shop.cart;
  shopFlowEl.foot.replaceChildren();
  if (!cart?.items.length) {
    shopFlowEl.foot.append(el_('span', 'muted small', 'Your cart is empty.'));
    return;
  }
  const count = cart.items.reduce((n, i) => n + i.qty, 0);
  const summary = el_('div', 'shop-foot-summary');
  summary.append(el_('strong', '', `${count} item${count === 1 ? '' : 's'} · ${money(cart.total_paise)}`),
    el_('span', 'muted small', shopFlow.pharmacy && shop.cart?.storeId === shopFlow.pharmacy.id ? shopFlow.pharmacy.name : 'In your cart'));
  shopFlowEl.foot.append(summary, shopFlowButton('Checkout', () => shopFlowShow('checkout'), 'shop-btn primary'));
}

// ---------- 1. the nearest pharmacies ----------

// "Use my current location", tapped here: the device's position (the browser
// asks), then the list measured from it.
async function shopFlowUseDevice() {
  const seq = ++shopFlow.seq;
  shopFlowMessage('Getting your location…', ['Allow location access when your browser asks.']);
  await locationRequestCurrent();
  if (seq === shopFlow.seq) shopFlowPharmacies();
}

async function shopFlowPharmacies({fresh = false} = {}) {
  const seq = ++shopFlow.seq;
  shopFlowHeader('Nearby pharmacies', shopFlowOrigin() || 'The nearest open pharmacies to you');
  shopFlowEl.foot.replaceChildren();
  // Only a device location is re-read ("Try again"); a typed address is never
  // swapped for the device's GPS behind the user's back.
  if (fresh && siruLocation.place?.source === 'device') {
    shopFlowMessage('Getting your location…', ['Allow location access when your browser asks.']);
    await locationRequestCurrent();
    if (seq !== shopFlow.seq) return;
  }
  const coords = shopFlowCoords();
  if (!coords) {
    // No coordinates to measure from: the user chooses how to give them.
    const typed = siruLocation.place?.source === 'manual';
    const code = siruLocation.error?.code || '';
    const detail = code === 'denied'
      ? ['Location is blocked for this site. Click the lock icon next to the address bar, set Location to Allow, then try again.']
      : code ? [siruLocation.error?.message || LOCATION_ERRORS[code] || ''] : [];
    const lines = typed
      ? ["Your delivery address isn't on the map yet, so pharmacies can't be measured from it. Find it on the map, or use your current location.", ...detail]
      : ['Choose where to deliver: your current location, or an address you confirm on the map.', ...detail];
    const actions = [shopFlowButton(typed ? 'Find my address on the map' : 'Enter an address', () => {
      shopFlowEl.dialog.close();
      locationOpen({manual: true});
    }, 'shop-btn primary')];
    if (code !== 'unsupported' && code !== 'insecure') actions.push(shopFlowButton('Use my current location', shopFlowUseDevice));
    shopFlowMessage(typed ? 'Confirm your address on the map' : 'Set your delivery location', lines, actions);
    return;
  }
  const key = `${coords.lat},${coords.lng}`;
  let stores = shopFlow.storesCache.get(key);
  if (!stores) {
    shopFlowMessage('Finding pharmacies near you…');
    try {
      const data = await apiFetch(`/v1/pharmacy/stores/nearby?lat=${coords.lat}&lng=${coords.lng}&limit=${SHOP_FLOW_NEAREST}`);
      stores = data.stores || [];
      shopFlow.storesCache.set(key, stores);
    } catch (error) {
      if (seq !== shopFlow.seq) return;
      shopFlowMessage("Couldn't load nearby pharmacies.", [pharmacyError(error)],
        [shopFlowButton('Try again', () => shopFlowPharmacies(), 'shop-btn primary')]);
      return;
    }
  }
  if (seq !== shopFlow.seq) return;
  if (!stores.length) {
    shopFlowMessage('No open pharmacies with a known location near you.', ['Pharmacies appear here once their shop location is set.']);
    return;
  }
  shopFlowHeader(`${stores.length === 1 ? 'The nearest pharmacy' : `The ${stores.length} nearest pharmacies`}`,
    shopFlowOrigin());
  const list = el_('ul', 'shop-list');
  for (const store of stores) {
    const row = el_('li', 'shop-store');
    const info = el_('div', 'shop-store-info');
    const top = el_('div', 'shop-store-top');
    top.append(el_('strong', '', store.name), el_('span', 'shop-badge open', 'OPEN'));
    // The server's measured distance - a straight line from the user's location, not
    // the road distance; a store without one is never listed (no made-up distance).
    // The store's own delivery time, or "—" - never an estimate made up here.
    const meta = [`${store.distanceKm} km away (straight line)`,
      store.etaMin ? `pharmacy's delivery estimate ${store.etaMin} min` : 'Delivery time unavailable',
      store.deliversHere === false ? "doesn't deliver here" : ''].filter(Boolean).join(' · ');
    info.append(top, el_('span', 'shop-store-meta', meta));
    const where = store.area && !String(store.address || '').includes(store.area)
      ? [store.address, store.area].filter(Boolean).join(', ') : (store.address || store.area || '');
    if (where) info.append(el_('span', 'muted small', where));
    const inCart = shop.cart?.items.length && shop.cart?.storeId === store.id;
    row.append(info, shopFlowButton(inCart ? 'Continue' : 'Select', () => shopFlowSelect(store), 'shop-btn primary'));
    list.append(row);
  }
  shopFlowEl.body.replaceChildren(list);
  shopFlowCartSummary();
}

function shopFlowSelect(store) {
  shopFlow.pharmacy = store;
  shopFlow.query = '';
  shopFlow.confirmSwitch = null;
  shopFlowShow('medicines');
}

// ---------- 2. the selected pharmacy's medicines ----------

async function shopFlowMedicines() {
  const pharmacy = shopFlow.pharmacy;
  if (!pharmacy) return shopFlowShow('pharmacies');
  const seq = ++shopFlow.seq;
  shopFlowHeader(pharmacy.name, `${pharmacy.distanceKm} km away (straight line)${pharmacy.area ? ` · ${pharmacy.area}` : ''}`, true);
  let products = shopFlow.shelfCache.get(pharmacy.id);
  if (!products) {
    shopFlowMessage('Loading medicines…');
    try {
      products = await apiFetch(`/v1/pharmacy/products?store_id=${encodeURIComponent(pharmacy.id)}`);
      shopFlow.shelfCache.set(pharmacy.id, products);
    } catch (error) {
      if (seq !== shopFlow.seq) return;
      shopFlowMessage("Couldn't load this pharmacy's medicines.", [pharmacyError(error)],
        [shopFlowButton('Try again', () => shopFlowMedicines(), 'shop-btn primary')]);
      return;
    }
  }
  if (seq !== shopFlow.seq) return;
  const wrap = el_('div', 'shop-medicines');
  const search = el_('input', 'shop-search');
  search.type = 'search';
  search.placeholder = `Search ${pharmacy.name}`;
  search.value = shopFlow.query;
  search.setAttribute('aria-label', 'Search medicines');
  const list = el_('ul', 'shop-list');
  wrap.append(search, list);
  if (shopFlow.confirmSwitch) wrap.prepend(shopFlowSwitchPrompt());
  shopFlowEl.body.replaceChildren(wrap);
  let timer = null;
  search.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { shopFlow.query = search.value; shopFlowRenderShelf(list, products); }, 150);
  };
  shopFlowRenderShelf(list, products);
  shopFlowCartSummary();
}

function shopFlowRenderShelf(list, products) {
  const words = shopFlow.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = products.filter(p => words.every(w => `${p.name} ${p.category || ''}`.toLowerCase().includes(w)));
  list.replaceChildren();
  if (!shown.length) {
    list.append(el_('li', 'shop-empty muted small', products.length ? 'No medicines match your search.' : 'This pharmacy has no medicines listed yet.'));
    return;
  }
  for (const product of shown) {
    const row = el_('li', 'shop-product');
    const info = el_('div', 'shop-product-info');
    info.append(el_('strong', '', product.name));
    const meta = [product.unit, product.prescriptionRequired ? 'Prescription needed' : '',
      product.inStock === false ? 'Out of stock' : ''].filter(Boolean).join(' · ');
    if (meta) info.append(el_('span', 'muted small', meta));
    const side = el_('div', 'shop-product-side');
    side.append(el_('span', 'shop-price', money(product.pricePaise)));
    const line = shopFlow.pharmacy && shop.cart?.storeId === shopFlow.pharmacy.id ? shopFlowCartLine(product.id) : null;
    if (line) {
      const qty = el_('span', 'cart-qty');
      const minus = shopFlowButton('−', () => shopFlowSetQty(product, line.qty - 1), 'qty-btn');
      const plus = shopFlowButton('+', () => shopFlowSetQty(product, line.qty + 1), 'qty-btn');
      minus.setAttribute('aria-label', `One less ${product.name}`);
      plus.setAttribute('aria-label', `One more ${product.name}`);
      qty.append(minus, el_('span', 'qty-value', String(line.qty)), plus);
      side.append(qty);
    } else {
      const add = shopFlowButton('Add', () => shopFlowAdd(product), 'shop-btn');
      add.disabled = product.inStock === false || product.prescriptionRequired;
      add.title = product.prescriptionRequired ? 'Needs a valid prescription' : product.inStock === false ? 'Out of stock' : '';
      side.append(add);
    }
    row.append(info, side);
    list.append(row);
  }
}

function shopFlowSwitchPrompt() {
  const box = el_('div', 'shop-confirm');
  box.append(el_('p', '', 'Your cart contains items from another pharmacy. Do you want to clear the existing cart and switch?'));
  const row = el_('div', 'shop-actions');
  row.append(
    shopFlowButton('Cancel', () => { shopFlow.confirmSwitch = null; shopFlowMedicines(); }),
    shopFlowButton('Switch pharmacy', () => {
      const pending = shopFlow.confirmSwitch;
      shopFlow.confirmSwitch = null;
      shopFlowAdd(pending.product, {replace: true});
    }, 'shop-btn primary'),
  );
  box.append(row);
  return box;
}

let shopFlowBusy = false;
async function shopFlowCartChange(run) {
  if (shopFlowBusy) return;
  const generation = shop.generation;  // whose cart change this is
  shopFlowBusy = true;
  shopFlowEl.body.classList.add('busy');
  try {
    await run();
    await shoppingRefresh();
  } catch (error) {
    // Signed out or switched meanwhile: the previous user's error - it can name
    // their product or pharmacy - and their "switch pharmacy?" are not the next user's.
    if (generation !== shop.generation) return;
    if (error.status === 409 && error.detail?.conflict === 'cart_store') throw error;
    if (shoppingPageLeaving) return;  // cut off by a reload or navigation - not a failure (shopping.js)
    shoppingNotice(`Couldn't update your cart. ${pharmacyError(error)}`);
  } finally {
    shopFlowBusy = false;
    shopFlowEl.body.classList.remove('busy');
  }
  if (shopFlow.step === 'medicines') shopFlowMedicines();
}

async function shopFlowAdd(product, {replace = false} = {}) {
  const user = encodeURIComponent(getUserId());
  try {
    await shopFlowCartChange(() => apiFetch(`/v1/pharmacy/cart/${user}/items${replace ? '?replace_cart=true' : ''}`, {
      method: 'POST', body: JSON.stringify({item_id: product.id, qty: 1}),
    }));
  } catch (error) {
    // Another pharmacy's cart: the user decides (never silently replaced).
    shopFlow.confirmSwitch = {product};
    shopFlowMedicines();
  }
}

function shopFlowSetQty(product, qty) {
  const user = encodeURIComponent(getUserId());
  return shopFlowCartChange(() => apiFetch(`/v1/pharmacy/cart/${user}/items/${encodeURIComponent(product.id)}`, {
    method: 'PUT', body: JSON.stringify({qty: Math.max(0, qty)}),
  }));
}

// ---------- 3. checkout ----------

function shopFlowAddressLine() {
  const place = siruLocation.place;
  if (!place) return null;
  if (place.source === 'manual') return [place.address, place.pincode].filter(Boolean).join(' – ');
  return `Current location (${place.lat.toFixed(3)}, ${place.lng.toFixed(3)})`;
}

async function shopFlowCheckout() {
  const seq = ++shopFlow.seq;
  shopFlowHeader('Checkout', 'Review your order', true);
  shopFlowEl.foot.replaceChildren();
  shopFlowMessage('Loading your order…');
  let bill;
  try {
    bill = await pharmacyApi.bill();
  } catch (error) {
    if (seq !== shopFlow.seq) return;
    shopFlowMessage("Couldn't load your cart.", [pharmacyError(error)], [shopFlowButton('Try again', () => shopFlowCheckout(), 'shop-btn primary')]);
    return;
  }
  if (seq !== shopFlow.seq) return;
  const cart = bill.cart;
  if (!cart.items.length) {
    shopFlowMessage('Your cart is empty.', ['Add medicines from a nearby pharmacy first.'],
      [shopFlowButton('Find pharmacies', () => shopFlowShow('pharmacies'), 'shop-btn primary')]);
    return;
  }
  const pharmacy = shopFlow.pharmacy && shopFlow.pharmacy.id === bill.storeId ? shopFlow.pharmacy : null;
  const wrap = el_('div', 'shop-checkout');
  if (shopFlow.notice) {
    // Shown once: why the checkout is shown again (a price changed, Bug #10).
    wrap.append(el_('p', 'shop-warn shop-price-notice', shopFlow.notice));
    shopFlow.notice = null;
  }
  const section = (title, ...children) => {
    const box = el_('section', 'shop-section');
    box.append(el_('h3', '', title), ...children);
    wrap.append(box);
    return box;
  };
  const address = shopFlowAddressLine();
  section('Delivery address', el_('p', address ? '' : 'shop-warn', address || 'No delivery address - set your location first.'));
  section('Pharmacy', el_('p', '', pharmacy ? `${pharmacy.name} · ${pharmacy.distanceKm} km away (straight line)` : (bill.cart.items[0] && 'The pharmacy your cart is from')));
  const items = el_('ul', 'shop-lines');
  for (const item of cart.items) {
    const li = el_('li', '');
    li.append(el_('span', '', `${item.name} × ${item.qty}`), el_('span', 'shop-price', money(item.line_total_paise)));
    items.append(li);
  }
  section('Order items', items);
  const b = bill.bill && !bill.bill.empty ? bill.bill : null;
  const prices = el_('ul', 'shop-lines');
  const priceRow = (label, value, cls = '') => {
    const li = el_('li', cls);
    li.append(el_('span', '', label), el_('span', 'shop-price', value));
    prices.append(li);
  };
  priceRow('Subtotal', money(b ? b.subtotalPaise : cart.total_paise));
  // The server's bill: the store's own delivery charge, "—" when it isn't recorded (never read as free).
  priceRow('Delivery fee', b && b.deliveryPaise != null ? (b.deliveryPaise ? money(b.deliveryPaise) : 'FREE') : '—');
  priceRow('Total', money(b ? b.totalPaise : cart.total_paise), 'shop-total');
  section('Price details', prices);

  const methods = el_('div', 'shop-methods');
  methods.setAttribute('role', 'radiogroup');
  methods.setAttribute('aria-label', 'Payment method');
  const note = el_('p', 'muted small shop-method-note');
  const options = [
    ['cod', 'Cash on Delivery', 'Pay when your order arrives'],
    ['card', 'Card', 'Debit or credit card'],
    ['upi', 'UPI', 'Any UPI app'],
  ];
  for (const [id, label, sub] of options) {
    const option = el_('label', 'shop-method');
    const radio = el_('input');
    radio.type = 'radio';
    radio.name = 'shopPayment';
    radio.value = id;
    radio.checked = shopFlow.payment === id;
    radio.onchange = () => { shopFlow.payment = id; shopFlowCheckoutState(place, note); };
    const text = el_('span', 'shop-method-text');
    text.append(el_('strong', '', label), el_('span', 'muted small', sub));
    option.append(radio, text);
    methods.append(option);
  }
  section('Payment method', methods, note);

  const place = shopFlowButton('Place order', () => shopFlowPlace(), 'shop-btn primary shop-place');
  shopFlowEl.body.replaceChildren(wrap);
  shopFlowEl.foot.append(el_('strong', 'shop-foot-total', `To pay ${money(b ? b.totalPaise : cart.total_paise)}`), place);
  shopFlowCheckoutState(place, note);
}

// Why "Place order" is off, or null when it can go.
function shopFlowCheckoutProblem() {
  if (!getUserId()) return 'Sign in to place an order.';
  if (!shopFlowAddressLine()) return 'Set your delivery location first.';
  if (!shop.cart?.items.length) return 'Your cart is empty.';
  if (!shopFlow.payment) return 'Choose a payment method.';
  if (shopFlow.payment !== 'cod') {
    return `${shopFlow.payment === 'upi' ? 'UPI' : 'Card'} payment isn't available on this server yet - no payment gateway is connected. Choose Cash on Delivery to place this order.`;
  }
  return null;
}

function shopFlowCheckoutState(place, note) {
  const problem = shopFlowCheckoutProblem();
  place.disabled = !!problem || shopFlow.placing;
  note.textContent = problem || 'Pay the rider in cash when your order arrives.';
  note.classList.toggle('shop-warn', !!problem && !!shopFlow.payment);
}

async function shopFlowPlace() {
  if (shopFlow.placing || shopFlowCheckoutProblem()) return;
  shopFlow.placing = true;
  const button = shopFlowEl.foot.querySelector('.shop-place');
  if (button) { button.disabled = true; button.textContent = 'Placing your order...'; }
  try {
    // The same prepare-then-confirm the chat uses: priced from the server's cart.
    // The delivery location goes with the order: the usual pharmacy is learned per location.
    const place = typeof locationTurnContext === 'function' ? locationTurnContext() : null;
    const where = place?.lat != null ? {lat: place.lat, lng: place.lng} : {};
    const prepared = await apiFetch('/v1/actions/orders', {method: 'POST', body: JSON.stringify({payment_method: shopFlow.payment, ...where})});
    const display = prepared.action?.display || {};
    if (display.price_changed) {
      // Bug #10: preparing re-priced the cart (the catalog's price changed since the
      // checkout was shown) - never confirmed at a price the user didn't see. The
      // prepared order is cancelled and the checkout shown again at the new price.
      await apiFetch(`/v1/actions/${encodeURIComponent(prepared.action.id)}/cancel`, {method: 'POST'})
        .catch(error => console.warn('siru: cancel of the re-priced order failed', error));
      const changed = (display.price_changes || []).map(c =>
        `${c.name} ${c.was_paise != null ? `${money(c.was_paise)} → ` : ''}${money(c.now_paise)}`);
      shopFlow.notice = `Prices changed since you opened checkout${changed.length ? `: ${changed.join('; ')}` : ''}. Review the new total and place the order again.`;
      await shoppingRefresh();
      shopFlowShow('checkout');
      return;
    }
    const done = await apiFetch(`/v1/actions/${encodeURIComponent(prepared.action.id)}/confirm`, {method: 'POST'});
    const order = done.order || {};
    await shoppingRefresh();
    shopFlowResult({ok: true, order});
  } catch (error) {
    shopFlowResult({ok: false, message: pharmacyError(error)});
  } finally {
    shopFlow.placing = false;
  }
}

// ---------- 4. result ----------

function shopFlowResult({ok, order, message}) {
  shopFlow.step = 'result';
  shopFlowEl.foot.replaceChildren();
  if (!ok) {
    shopFlowHeader('Order not placed', '', false);
    shopFlowMessage("Your order wasn't placed.", [message || 'Please try again.'], [
      shopFlowButton('Back to checkout', () => shopFlowShow('checkout'), 'shop-btn primary'),
    ]);
    return;
  }
  shopFlowHeader('Order placed', '', false);
  const lines = [`Order ID: ${order.orderNumber || '—'}`, `Total ${money(order.totalPaise ?? order.orderTotalPaise)} · Cash on Delivery`];
  if (order.demo) lines.push('Saved in this app as a demo order - it is not sent to the pharmacy.');
  shopFlowMessage('Order placed successfully', lines, [
    shopFlowButton('View order', () => { shopFlowEl.dialog.close(); shoppingOrders(); }, 'shop-btn primary'),
    shopFlowButton('Continue shopping', () => shopFlowShow(shopFlow.pharmacy ? 'medicines' : 'pharmacies')),
  ]);
}

// ---------- navigation ----------

function shopFlowShow(step) {
  shopFlow.step = step;
  if (step === 'pharmacies') return shopFlowPharmacies();
  if (step === 'medicines') return shopFlowMedicines();
  if (step === 'checkout') return shopFlowCheckout();
}

function shopFlowOpen(step = 'pharmacies') {
  if (!getUserId()) return;
  if (shopFlow.owner !== getUserId()) {
    // Another user signed in: none of the previous user's choices carry over.
    Object.assign(shopFlow, {owner: getUserId(), pharmacy: null, payment: null, query: '', confirmSwitch: null});
  }
  if (!shopFlowEl.dialog.open) {
    shopFlowEl.dialog.showModal();
    document.documentElement.classList.add('shop-open');  // the page behind stays put
  }
  shopFlowShow(step);
}

shopFlowEl.back.onclick = () => shopFlowShow(shopFlow.step === 'checkout' && shopFlow.pharmacy ? 'medicines' : 'pharmacies');
shopFlowEl.dialog.addEventListener('close', () => {
  shopFlow.seq++;
  shopFlow.confirmSwitch = null;
  document.documentElement.classList.remove('shop-open');
});
document.getElementById('shopNearbyBtn')?.addEventListener('click', () => shopFlowOpen('pharmacies'));

// The active location changed (another address confirmed, the device's
// position, signed out): nothing measured from the old one is kept - the
// pharmacy picked from that list is let go, and an open list is measured again.
let shopFlowPlaceKey = null;
locationSubscribe(({place}) => {
  const key = place ? `${place.source}:${place.lat}:${place.lng}` : '';
  if (key === shopFlowPlaceKey) return;
  const changed = shopFlowPlaceKey !== null;
  shopFlowPlaceKey = key;
  if (!changed) return;
  shopFlow.storesCache.clear();
  // Its distance was from the old place (the cart's pharmacy is "Continue" on the new list).
  shopFlow.pharmacy = null;
  if (shopFlowEl.dialog.open && shopFlow.step !== 'checkout') shopFlowShow('pharmacies');
});
