// The Memory tab of the activity panel (the Tool calls tab is in shopping.js).
//
// Memory belongs to the user, not to a chat session: it survives signing out,
// signing in and starting a new chat. The server extracts it from finished
// turns (multi_agent_framework/memory/extractor.py) and stores it in
// long_term_memories; this tab reads GET /v1/memory/me and can forget one
// item. It never shows chat messages - only the facts kept from them.
const memoryEl = Object.fromEntries([
  "memoryList", "memoryEmpty", "memoryCount", "memoryCountTop", "memoryStatus",
  "memoryConsent", "memoryConsentNote", "stmBadge", "stmSummary", "stmRecent", "memoryCart", "memoryOrders",
].map(id => [id, document.getElementById(id)]));

const MEMORY_LABELS = {
  preference: 'Preference', language: 'Language', medicine: 'Medicine',
  order: 'Order', health: 'Health', allergy: 'Allergy', other: 'Other',
};
// Voice saves memory in the background, after the reply: look again once the
// save has had time to finish.
const MEMORY_DELAY_MS = 3000;
let memoryLoading = null;
let memoryDelayTimer = null;

function memoryWhen(item) {
  const created = new Date(item.created_at);
  const updated = new Date(item.updated_at);
  const day = date => date.toLocaleDateString([], {day: 'numeric', month: 'short'});
  // Said again since: show both, so a fact that is still current is visible.
  return updated - created > 60000 ? `${day(created)} · again ${day(updated)}` : day(created);
}

// Forgetting is the user's call: their memory, their decision what Siru keeps.
async function memoryForget(item, row) {
  const button = row.querySelector('.memory-forget');
  button.disabled = true;
  try {
    await pharmacyApi.forgetMemory(item.id);
    row.remove();
    const count = memoryEl.memoryList.children.length;
    memoryEl.memoryCount.textContent = count;
    memoryEl.memoryCountTop.textContent = count;
    memoryEl.memoryEmpty.hidden = count > 0;
  } catch (error) {
    button.disabled = false;
    memoryEl.memoryStatus.textContent = "Couldn't forget that just now.";
  }
}

function memoryItem(item) {
  const row = el_('article', 'memory-item');
  const head = el_('div', 'memory-head');
  head.append(el_('p', 'memory-text', item.text));
  const forget = el_('button', 'icon-btn memory-forget');
  forget.append(icon('trash'));
  forget.type = 'button';
  forget.title = 'Forget this';
  forget.setAttribute('aria-label', `Forget: ${item.text}`);
  forget.onclick = () => memoryForget(item, row);
  head.append(forget);
  row.append(head);
  // user_id, category, where it was said, when, and the consent it is kept under.
  const meta = el_('div', 'memory-meta');
  meta.append(el_('span', `memory-tag ${item.category}`, MEMORY_LABELS[item.category] || MEMORY_LABELS.other));
  meta.append(el_('span', '', item.source === 'voice' ? 'Voice' : 'Chat'));
  const when = el_('time', '', memoryWhen(item));
  when.dateTime = item.updated_at;
  when.title = new Date(item.updated_at).toLocaleString();
  meta.append(when);
  meta.append(el_('span', `memory-consent ${item.consent === 'granted' ? '' : 'paused'}`.trim(),
    item.consent === 'granted' ? 'Consent: granted' : 'Consent: paused'));
  if (item.user_id) meta.append(el_('span', 'memory-user', item.user_id));
  row.append(meta);
  return row;
}

function memoryRender(items) {
  memoryEl.memoryList.replaceChildren(...items.map(memoryItem));
  memoryEl.memoryCount.textContent = items.length;
  memoryEl.memoryCountTop.textContent = items.length;
  memoryEl.memoryEmpty.hidden = items.length > 0;
}

function memoryDuration(seconds) {
  if (seconds == null) return '';
  // Whole minutes first, then split: 86 392 s is "24 h 0 min", never "23 h 60 min".
  const minutes = Math.round(seconds / 60), h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

// Short-term: what Redis holds for this conversation right now. Reading it
// doesn't extend it (memory/short_term.py inspect).
async function memoryShortTermRefresh(userId) {
  const conversation = typeof shoppingSessionId === 'string' && shoppingSessionId ? shoppingSessionId : null;
  const badge = (text, tone) => { memoryEl.stmBadge.textContent = text; memoryEl.stmBadge.className = `memory-badge ${tone || ''}`.trim(); };
  memoryEl.stmRecent.replaceChildren();
  if (!conversation) { badge('Not active'); memoryEl.stmSummary.textContent = 'No conversation yet.'; return; }
  let data;
  try {
    data = await apiFetch(`/v1/memory/me/short-term?conversation_id=${encodeURIComponent(conversation)}`);
  } catch (error) {
    badge('Unknown', 'warn');
    memoryEl.stmSummary.textContent = `Couldn't read short-term memory. ${pharmacyError(error)}`;
    return;
  }
  if (getUserId() !== userId) return;
  if (data.status === 'off') { badge('Off'); memoryEl.stmSummary.textContent = 'Short-term memory is not configured on the server (REDIS_URL).'; return; }
  if (data.status === 'unavailable') { badge('Unavailable', 'warn'); memoryEl.stmSummary.textContent = 'Redis is not reachable right now - this conversation uses the history the app sends.'; return; }
  if (data.status !== 'active') { badge('Not active'); memoryEl.stmSummary.textContent = 'Nothing held for this conversation (none yet, or it expired after 24 h without activity).'; return; }
  badge('Active', 'ok');
  const last = data.last_activity_at ? new Date(data.last_activity_at * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
  memoryEl.stmSummary.textContent = [`${data.messages} message${data.messages === 1 ? '' : 's'} (keeps the last ${data.max_messages})`,
    data.ttl_seconds != null ? `expires in ${memoryDuration(data.ttl_seconds)} unless you continue` : '',
    last ? `last activity ${last}` : ''].filter(Boolean).join(' · ');
  for (const item of data.recent || []) {
    const li = el_('li', `stm-item stm-${item.role}`);
    li.append(el_('span', 'stm-role', item.role === 'user' ? 'You' : 'Siru'), el_('span', 'stm-text', item.content));
    memoryEl.stmRecent.append(li);
  }
}

// ---------- shopping state, as cards: the cart and the order history ----------
//
// Not memory: the cart is the server's cart as it is now (the same normalised
// cart the cart dialog shows - shopping.js shoppingRenderCart calls
// memoryCartRender), the orders are what the Orders dialog reads - the SIRU
// orders (GET /v1/sandbox/orders) and the demo orders confirmed in this app
// (GET /v1/actions/demo). Nothing here is stored as a remembered fact.
const STATE_PLACEHOLDER = 'images/medicine.svg';

function stateImage(src) {
  const img = el_('img', 'state-img');
  img.alt = '';
  img.width = 48;
  img.height = 48;
  img.loading = 'lazy';
  img.src = src || STATE_PLACEHOLDER;
  img.onerror = () => { img.onerror = null; img.src = STATE_PLACEHOLDER; };
  return img;
}

function stateItemRow({name, qty, pricePaise, image}) {
  const row = el_('div', 'state-item');
  const info = el_('div', 'state-item-info');
  info.append(el_('strong', '', name || 'Medicine'),
    el_('span', 'muted small', [pricePaise != null ? money(pricePaise) : 'Price unavailable', `Qty: ${qty || 1}`].join(' · ')));
  row.append(stateImage(image), info,
    el_('span', 'state-amount', pricePaise != null ? money(pricePaise * (qty || 1)) : ''));
  return row;
}

// The cart as it is now; `cart` is shopping.js's normalised cart (null: not loaded yet).
function memoryCartRender(cart) {
  const box = memoryEl.memoryCart;
  if (!box) return;
  if (!getUserId() || !cart) {
    box.replaceChildren(el_('p', 'muted small', getUserId() ? 'Loading the cart…' : 'Sign in to see your cart.'));
    return;
  }
  if (!cart.items.length) {
    box.replaceChildren(el_('p', 'muted small', 'Your cart is empty.'));
    return;
  }
  const card = el_('article', 'state-card');
  card.append(el_('div', 'state-card-head', 'CART'));
  for (const item of cart.items) {
    card.append(stateItemRow({name: item.name, qty: item.qty, pricePaise: item.price_paise, image: item.image_url}));
  }
  const foot = el_('div', 'state-card-foot');
  foot.append(el_('span', '', 'Items total'), el_('strong', '', cart.total_paise != null ? money(cart.total_paise) : 'Price unavailable'));
  card.append(foot);
  box.replaceChildren(card);
}

function orderCard({title, status, source, when, items, totalPaise}) {
  const card = el_('article', 'state-card');
  const head = el_('div', 'state-card-head');
  head.append(el_('span', '', title), el_('span', 'state-status', status));
  card.append(head);
  if (source || when) card.append(el_('p', 'muted small state-card-meta', [source, when].filter(Boolean).join(' · ')));
  for (const item of items || []) {
    card.append(stateItemRow({name: item.name, qty: item.qty,
      pricePaise: item.unit_price_paise ?? item.unitPricePaise ?? null,
      image: item.image_url || pharmacyApi.imageFor(item.name)}));
  }
  const foot = el_('div', 'state-card-foot');
  foot.append(el_('span', '', 'Total'), el_('strong', '', totalPaise != null ? money(totalPaise) : 'Total unavailable'));
  card.append(foot);
  return card;
}

const ORDER_STATUS_WORDS = {CONFIRMED_DEMO: 'Confirmed (demo)'};

function orderStatus(status) {
  return ORDER_STATUS_WORDS[status] || String(status || 'Unknown').toLowerCase().replace(/_/g, ' ');
}

function orderWhen(value) {
  return value ? new Date(value).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : '';
}

// The newest orders of both sources, as cards; bookings as a count.
async function memoryOrdersRefresh(userId) {
  const box = memoryEl.memoryOrders;
  if (!box) return;
  const [siru, demo] = await Promise.allSettled([pharmacyApi.orders(), apiFetch('/v1/actions/demo')]);
  if (getUserId() !== userId) return;
  const cards = [];
  for (const order of (demo.status === 'fulfilled' ? demo.value.orders || [] : [])) {
    cards.push({at: order.createdAt, card: orderCard({title: `ORDER ${order.id}`, status: orderStatus(order.status),
      source: 'Demo - saved in this app only', when: orderWhen(order.createdAt), items: order.items, totalPaise: order.totalPaise})});
  }
  for (const order of (siru.status === 'fulfilled' && Array.isArray(siru.value) ? siru.value : [])) {
    cards.push({at: order.createdAt, card: orderCard({title: `ORDER ${order.orderNumber || order.id}`, status: orderStatus(order.status),
      source: ['SIRU', order.storeName].filter(Boolean).join(' · '), when: orderWhen(order.createdAt),
      items: order.items, totalPaise: order.orderTotalPaise})});
  }
  cards.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const shown = cards.slice(0, 5).map(c => c.card);
  const notes = [];
  if (siru.status === 'rejected' && demo.status === 'rejected') notes.push("Couldn't load your orders just now.");
  if (!cards.length && !notes.length) notes.push('No orders yet.');
  if (cards.length > shown.length) notes.push(`${cards.length - shown.length} older order(s) in My orders.`);
  const bookings = demo.status === 'fulfilled' ? (demo.value.bookings || []).length : 0;
  if (bookings) notes.push(`${bookings} booking(s) confirmed in this app.`);
  box.replaceChildren(...shown, ...notes.map(text => el_('p', 'muted small', text)));
}

// Reads the user's memory into the tab. `delayed` waits for a turn's
// background save first. Best effort: a failure leaves what is on screen.
function memoryRefresh({delayed = false} = {}) {
  clearTimeout(memoryDelayTimer);
  if (!getUserId()) { memoryRender([]); memoryEl.memoryStatus.textContent = 'Sign in to see what Siru remembers.'; return; }
  if (delayed) { memoryDelayTimer = setTimeout(() => memoryRefresh(), MEMORY_DELAY_MS); return; }
  if (memoryLoading) return memoryLoading;
  const userId = getUserId();
  memoryEl.memoryStatus.textContent = 'Loading…';
  memoryShortTermRefresh(userId);
  memoryCartRender(typeof shop === 'object' ? shop.cart : null);
  memoryOrdersRefresh(userId);
  memoryLoading = pharmacyApi.memory()
    .then(data => {
      if (getUserId() !== userId) return;
      memoryRender(Array.isArray(data.items) ? data.items : []);
      memoryConsentShow(data.memory_enabled !== false);
      memoryEl.memoryStatus.textContent = '';
    })
    .catch(error => {
      if (getUserId() !== userId) return;
      memoryEl.memoryStatus.textContent = error.status === 404
        ? 'Memory needs a newer pharmacy API.' : "Couldn't load memory just now.";
    })
    .finally(() => { memoryLoading = null; });
  return memoryLoading;
}

// The consent switch: off means nothing new is remembered from here on.
// What is already remembered stays until the user deletes it.
function memoryConsentShow(enabled) {
  memoryEl.memoryConsent.checked = enabled;
  memoryEl.memoryConsentNote.textContent = enabled
    ? 'New facts are saved. Turning this off keeps what is already here.'
    : 'Paused: nothing new is remembered. What is already here is kept.';
}

memoryEl.memoryConsent.onchange = async event => {
  const enabled = event.target.checked;
  memoryEl.memoryConsent.disabled = true;
  try {
    await pharmacyApi.setMemoryConsent(enabled);
    memoryConsentShow(enabled);
    memoryRefresh();
  } catch (error) {
    memoryEl.memoryConsent.checked = !enabled;
    memoryEl.memoryStatus.textContent = "Couldn't change that just now.";
  } finally {
    memoryEl.memoryConsent.disabled = false;
  }
};

document.getElementById('memoryBtn').onclick = () => panelShow('memory', {toggle: true});
