// The Memory tab of the activity panel (the Tool calls tab is in shopping.js).
//
// Memory belongs to the user, not to a chat session: it survives signing out,
// signing in and starting a new chat. The server extracts it from finished
// turns (multi_agent_framework/memory/extractor.py) and stores it in
// long_term_memories; this tab reads GET /v1/memory/me and can forget one
// item. It never shows chat messages - only the facts kept from them.
const memoryEl = Object.fromEntries([
  "memoryList", "memoryEmpty", "memoryCount", "memoryCountTop", "memoryStatus",
  "memoryConsent", "memoryConsentNote", "stmBadge", "stmSummary", "stmRecent", "memoryCart", "memoryOrders", "memoryRefills",
  "memoryForgetAll", "householdCount", "householdStatus", "householdEmpty", "householdList",
  "rxCount", "rxStatus", "rxList", "addrCount", "addrStatus", "addrList", "schedCount", "schedStatus", "schedList",
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
// Whose memory the list on screen is, as the server last answered it (null:
// nobody's yet). A failed load never shows "0 remembered" for a list that was
// never loaded - nor keeps another user's list.
let memoryShownFor = null;

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
    memoryCountsShow();
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
  meta.append(el_('span', 'memory-tag long', 'Long-term'));
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
  memoryCountsShow();
}

// The counts and the empty state from what is on screen: the Memory button
// counts the personal facts and the household profiles; "Nothing remembered
// yet" only when there are neither - personal facts can be none while the
// household section below has records.
// One number for Long-Term Memory, on both badges (the Memory button and the
// Inspector's Memory tab): personal facts + household profiles (their
// allergies are part of the profile, not counted again) + saved addresses +
// prescriptions + refill schedules - each read from its own service. Not the
// cart, orders or short-term memory. A section not loaded counts as 0.
function memoryLongTermCount() {
  const rows = el => (el ? el.querySelectorAll(':scope > article').length : 0);
  return {facts: rows(memoryEl.memoryList), members: rows(memoryEl.householdList), addresses: rows(memoryEl.addrList),
    prescriptions: rows(memoryEl.rxList), schedules: rows(memoryEl.schedList)};
}

function memoryCountsShow() {
  const counts = memoryLongTermCount();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  memoryEl.memoryCount.textContent = total;
  memoryEl.memoryCountTop.textContent = total;
  memoryEl.memoryEmpty.hidden = counts.facts > 0;
  memoryEl.memoryEmpty.textContent = total > counts.facts
    ? 'No personal facts yet - your other long-term records are below.' : 'Nothing remembered yet.';
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
// orders (GET /v1/pharmacy/orders) and the demo orders confirmed in this app
// (GET /v1/actions/demo). Nothing here is stored as a remembered fact.
const STATE_PLACEHOLDER = 'images/medicine.svg';

function stateImage(src) {
  const img = el_('img', 'state-img');
  img.alt = '';
  img.width = 48;
  img.height = 48;
  img.loading = 'lazy';
  img.src = safeImageUrl(src, STATE_PLACEHOLDER);
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

// The cart as it is now; `cart` is shopping.js's normalised cart (null: not
// loaded yet). `failed`: the load failed and no cart was loaded - said, not
// left "loading" (shopping.js shoppingRefresh).
function memoryCartRender(cart, {failed = ''} = {}) {
  const box = memoryEl.memoryCart;
  if (!box) return;
  if (getUserId() && !cart && failed) {
    box.replaceChildren(el_('p', 'muted small', `Couldn't load your cart just now. ${failed}`));
    return;
  }
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
  // Another user's orders never stay on screen while this user's load.
  if (box.dataset.owner !== userId) {
    box.dataset.owner = userId;
    box.replaceChildren(el_('p', 'muted small', 'Loading orders…'));
  }
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
  // Each source's failure is said: "No orders yet." only when both answered.
  if (siru.status === 'rejected' && demo.status === 'rejected') notes.push("Couldn't load your orders just now.");
  else if (siru.status === 'rejected') notes.push("Couldn't load your SIRU orders just now - only orders confirmed in this app are shown.");
  else if (demo.status === 'rejected') notes.push("Couldn't load the orders confirmed in this app just now.");
  if (!cards.length && !notes.length) notes.push('No orders yet.');
  if (cards.length > shown.length) notes.push(`${cards.length - shown.length} older order(s) in My orders.`);
  const bookings = demo.status === 'fulfilled' ? (demo.value.bookings || []).length : 0;
  if (bookings) notes.push(`${bookings} booking(s) confirmed in this app.`);
  box.replaceChildren(...shown, ...notes.map(text => el_('p', 'muted small', text)));
}

// Refills due, predicted from the refill schedule or the order history
// (GET /v1/concierge/refills) - what the server returns, nothing made up here.
async function memoryRefillsRefresh(userId) {
  const box = memoryEl.memoryRefills;
  if (!box) return;
  if (box.dataset.owner !== userId) {
    box.dataset.owner = userId;
    box.replaceChildren(el_('p', 'muted small', 'Loading refills…'));
  }
  let items;
  try {
    const data = await apiFetch('/v1/concierge/refills');
    items = Array.isArray(data.items) ? data.items : [];
  } catch (error) {
    if (getUserId() !== userId) return;
    box.replaceChildren(el_('p', 'muted small', `Couldn't load refills just now. ${pharmacyError(error)}`));
    return;
  }
  if (getUserId() !== userId) return;
  if (!items.length) {
    box.replaceChildren(el_('p', 'muted small', 'No refills due - they appear once a medicine is ordered more than once or a refill schedule is set.'));
    return;
  }
  box.replaceChildren(...items.slice(0, 8).map(item => {
    const row = el_('article', 'memory-item refill-item');
    row.append(el_('p', 'memory-text', item.medName || 'Medicine'));
    const meta = el_('div', 'memory-meta');
    const days = Number(item.daysUntil);
    meta.append(el_('span', 'memory-tag other', days < 0 ? 'Overdue' : days === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`));
    if (item.dueDate) meta.append(el_('span', '', item.dueDate));
    meta.append(el_('span', '', item.source === 'refill_schedule' ? 'Refill schedule' : 'From your order history'));
    row.append(meta);
    return row;
  }));
}

// Reads the user's memory into the tab. `delayed` waits for a turn's
// background save first. Best effort: a failure leaves this user's list as
// last loaded; with none loaded yet the count is unknown ("–"), not 0.
function memoryRefresh({delayed = false} = {}) {
  clearTimeout(memoryDelayTimer);
  if (!getUserId()) {
    // Signed out: nothing of the previous user stays in the tab.
    memoryRender([]);
    memoryShownFor = null;
    memoryEl.memoryStatus.textContent = 'Sign in to see what Siru remembers.';
    memoryCartRender(null);
    memoryEl.memoryOrders.replaceChildren();
    delete memoryEl.memoryOrders.dataset.owner;
    if (memoryEl.memoryRefills) { memoryEl.memoryRefills.replaceChildren(); delete memoryEl.memoryRefills.dataset.owner; }
    memoryEl.stmRecent.replaceChildren();
    memoryEl.stmSummary.textContent = 'No conversation yet.';
    if (typeof householdReset === 'function') householdReset();
    if (typeof rxReset === 'function') rxReset();
    if (typeof addrReset === 'function') addrReset();
    if (typeof schedReset === 'function') schedReset();
    return;
  }
  if (delayed) { memoryDelayTimer = setTimeout(() => memoryRefresh(), MEMORY_DELAY_MS); return; }
  if (memoryLoading) return memoryLoading;
  const userId = getUserId();
  memoryEl.memoryStatus.textContent = 'Loading…';
  memoryShortTermRefresh(userId);
  memoryCartRender(typeof shop === 'object' ? shop.cart : null);
  memoryOrdersRefresh(userId);
  memoryRefillsRefresh(userId);
  householdRefresh(userId);
  rxRefresh(userId);
  addrRefresh(userId);
  schedRefresh(userId);
  memoryLoading = pharmacyApi.memory()
    .then(data => {
      if (getUserId() !== userId) return;
      memoryRender(Array.isArray(data.items) ? data.items : []);
      memoryShownFor = userId;
      memoryConsentShow(data.memory_enabled !== false);
      memoryEl.memoryStatus.textContent = '';
    })
    .catch(error => {
      if (getUserId() !== userId) return;
      if (memoryShownFor !== userId) {
        // Not loaded is not "nothing remembered" (e.g. the server's app
        // database is unreachable): no count, no empty state.
        memoryEl.memoryList.replaceChildren();
        memoryEl.memoryCount.textContent = '–';
        memoryEl.memoryCountTop.textContent = '–';
        memoryEl.memoryEmpty.hidden = true;
      }
      memoryEl.memoryStatus.textContent = error.status === 404
        ? 'Memory needs a newer pharmacy API.' : `Couldn't load memory just now. ${pharmacyError(error)}`;
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

// "Forget everything": the server deletes what it keeps about this user in
// every store it owns, and this device's copies of their chats and activity
// go too. Their cart and orders are business records and stay.
memoryEl.memoryForgetAll.onclick = async () => {
  const owner = getUserId();
  if (!owner || !window.confirm('Forget everything Siru remembers about you? Your cart and orders stay.')) return;
  memoryEl.memoryForgetAll.disabled = true;
  try {
    const result = await pharmacyApi.forgetEverything();
    if (owner !== getUserId()) return;
    userForgetDevice();
    // A new conversation too: the chat on screen and this tab's conversation id
    // belonged to what was just forgotten (the server dropped its short-term
    // memory) - the audit found them left in step with nothing (2 Oct).
    if (typeof shoppingNewChat === 'function') await shoppingNewChat();
    // The list reloaded first: a successful load clears the status line, which
    // used to wipe this confirmation right after it was shown.
    await memoryRefresh();
    if (owner !== getUserId()) return;
    memoryEl.memoryStatus.textContent = result?.complete === false
      ? "Forgotten - but part of it couldn't be reached just now; what's left expires within a day."
      : 'Forgotten. Siru no longer remembers anything about you.';
  } catch (error) {
    memoryEl.memoryStatus.textContent = `Couldn't forget just now: ${pharmacyError(error)}`;
  } finally {
    memoryEl.memoryForgetAll.disabled = false;
  }
};

// ---------- household profiles (GET/POST/PATCH/DELETE /v1/household/me) ----------
//
// The people this user shops for - named in a conversation
// ("My mother's name is Saroja, and she is 62"), each labelled with where it
// came from and when, earlier values kept - never a medicine or dose. Only the signed-in
// user's own (the server takes the user from the login). Loading, empty and
// failed are three different states; another user's profiles never stay.
const HOUSEHOLD_LABELS = {mother: 'Mother', father: 'Father', spouse: 'Spouse', son: 'Son', daughter: 'Daughter',
  child: 'Child', sibling: 'Sibling', grandparent: 'Grandparent', grandchild: 'Grandchild', other: 'Other'};
let householdShownFor = null;

function householdReset() {
  householdShownFor = null;
  memoryEl.householdList.replaceChildren();
  memoryEl.householdCount.textContent = '0';
  memoryEl.householdEmpty.hidden = true;
  memoryEl.householdStatus.textContent = '';
}

function householdItem(member) {
  const row = el_('article', 'memory-item household-item');
  const head = el_('div', 'memory-head');
  head.append(el_('p', 'memory-text', member.label));
  const remove = el_('button', 'icon-btn memory-forget');
  remove.append(icon('trash'));
  remove.type = 'button';
  remove.title = 'Delete this profile';
  remove.setAttribute('aria-label', `Delete the profile: ${member.label}`);
  remove.onclick = () => householdDelete(member, row, remove);
  head.append(remove);
  row.append(head);
  const meta = el_('div', 'memory-meta');
  meta.append(el_('span', 'memory-tag long', 'Long-term'));
  meta.append(el_('span', 'memory-tag other', HOUSEHOLD_LABELS[member.relationship] || 'Other'));
  if (member.age_years != null) meta.append(el_('span', '', `Age ${member.age_years}`));
  // Where it came from, and when: typed in here, or said in a conversation.
  meta.append(el_('span', 'household-source', member.source === 'conversation' ? 'From a conversation' : 'Entered by you'));
  const when = member.updated_at || member.created_at;
  if (when) meta.append(el_('span', '', orderWhen(when)));
  row.append(meta);
  if (member.note) row.append(el_('p', 'muted small household-note', member.note));
  // Health notes the user reported for this person (an allergy): what, where
  // it came from, when - and that it is user-reported, not a verified record.
  for (const note of Array.isArray(member.health_notes) ? member.health_notes : []) {
    const box = el_('div', 'household-health');
    const line = el_('div', 'memory-head');
    line.append(el_('p', 'memory-text', `${note.kind === 'allergy' ? 'Allergy' : 'Health note'}: ${note.value}`));
    const drop = el_('button', 'icon-btn memory-forget');
    drop.append(icon('trash'));
    drop.type = 'button';
    drop.title = 'Delete this note';
    drop.setAttribute('aria-label', `Delete the note: ${note.value}`);
    drop.onclick = () => householdNoteDelete(member, note, box, drop);
    line.append(drop);
    box.append(line);
    const about = el_('div', 'memory-meta');
    about.append(el_('span', 'memory-tag health', 'Long-term · Household health'));
    about.append(el_('span', '', note.source === 'conversation' ? 'From a conversation' : 'Entered by you'));
    if (note.recorded_at) about.append(el_('span', '', orderWhen(note.recorded_at)));
    about.append(el_('span', 'household-status', 'User-reported; not medically verified'));
    box.append(about);
    row.append(box);
  }
  // A changed value is never silently lost: the earlier ones, newest first.
  const history = Array.isArray(member.history) ? member.history : [];
  if (history.length) {
    const words = {age_years: 'age', label: 'name', relationship: 'relationship', note: 'note'};
    row.append(el_('p', 'muted small household-history', 'Earlier: ' + history.slice().reverse()
      .map(h => `${words[h.field] || h.field} ${h.value}${h.until ? ` (until ${orderWhen(h.until)})` : ''}`).join('; ')));
  }
  return row;
}

function householdRender(members) {
  memoryEl.householdList.replaceChildren(...members.map(householdItem));
  memoryEl.householdCount.textContent = members.length;
  memoryEl.householdEmpty.hidden = members.length > 0;
  memoryCountsShow();
}

async function householdNoteDelete(member, note, box, button) {
  if (!window.confirm(`Delete "${note.value}" from ${member.label}'s profile?`)) return;
  button.disabled = true;
  try {
    await apiFetch(`/v1/household/me/${encodeURIComponent(member.id)}/notes/${encodeURIComponent(note.id)}`, {method: 'DELETE'});
    box.remove();
    memoryEl.householdStatus.textContent = '';
  } catch (error) {
    button.disabled = false;
    memoryEl.householdStatus.textContent = `Couldn't delete that just now. ${pharmacyError(error)}`;
  }
}

async function householdRefresh(userId = getUserId()) {
  if (!userId) { householdReset(); return; }
  if (householdShownFor !== userId) {
    householdReset();
    memoryEl.householdStatus.textContent = 'Loading…';
  }
  try {
    const data = await apiFetch('/v1/household/me');
    if (getUserId() !== userId) return;
    householdShownFor = userId;
    householdRender(Array.isArray(data.members) ? data.members : []);
    memoryEl.householdStatus.textContent = '';
  } catch (error) {
    if (getUserId() !== userId) return;
    if (householdShownFor !== userId) {
      // Not loaded is not "no profiles": no count, no empty state.
      memoryEl.householdList.replaceChildren();
      memoryEl.householdCount.textContent = '–';
      memoryEl.householdEmpty.hidden = true;
    }
    memoryEl.householdStatus.textContent = `Couldn't load household profiles just now. ${pharmacyError(error)}`;
  }
}

async function householdDelete(member, row, button) {
  if (!window.confirm(`Delete the profile "${member.label}"? This can't be undone.`)) return;
  button.disabled = true;
  try {
    await apiFetch(`/v1/household/me/${encodeURIComponent(member.id)}`, {method: 'DELETE'});
    row.remove();
    const count = memoryEl.householdList.children.length;
    memoryEl.householdCount.textContent = count;
    memoryEl.householdEmpty.hidden = count > 0;
    if (memoryShownFor === getUserId()) memoryCountsShow();
    memoryEl.householdStatus.textContent = '';
  } catch (error) {
    button.disabled = false;
    memoryEl.householdStatus.textContent = `Couldn't delete that just now. ${pharmacyError(error)}`;
  }
}

// ---------- prescriptions (GET/PATCH/DELETE /v1/prescriptions/me) ----------
//
// Read from the user's photos (prescriptions/extract.py): the date written on
// the prescription (never the upload's), the patient, the medicines - each
// unclear one marked, never guessed - and whether the user has confirmed it.
// Confirming needs every uncertain field checked; it is the user's check,
// not a pharmacist's. Only the signed-in user's own.
let rxShownFor = null;

function rxReset() {
  rxShownFor = null;
  if (!memoryEl.rxList) return;
  memoryEl.rxList.replaceChildren();
  memoryEl.rxCount.textContent = '0';
  memoryEl.rxStatus.textContent = '';
}

const RX_FIELD_WORDS = {patient_name: 'patient name', prescription_date: 'prescription date'};

function rxItem(rx) {
  const row = el_('article', 'memory-item rx-item');
  const head = el_('div', 'memory-head');
  head.append(el_('p', 'memory-text', `Patient: ${rx.patient_name || 'Not readable - please add'}`));
  const remove = el_('button', 'icon-btn memory-forget');
  remove.append(icon('trash'));
  remove.type = 'button';
  remove.title = 'Delete this prescription';
  remove.setAttribute('aria-label', 'Delete this prescription');
  remove.onclick = () => rxDelete(rx, row, remove);
  head.append(remove);
  row.append(head);
  const meta = el_('div', 'memory-meta');
  meta.append(el_('span', 'memory-tag long', 'Long-term'));
  meta.append(el_('span', '', `Prescription date: ${rx.prescription_date || 'not readable'}`));
  if (rx.uploaded_at) meta.append(el_('span', '', `Uploaded ${orderWhen(rx.uploaded_at)}`));
  meta.append(el_('span', 'household-status', rx.verification === 'confirmed_by_user'
    ? 'Confirmed by you' : 'OCR extracted - awaiting your confirmation'));
  row.append(meta);
  const lines = el_('ul', 'rx-lines');
  for (const item of rx.items || []) {
    const line = el_('li', item.unclear ? 'rx-unclear' : '', [item.name, item.strength].filter(Boolean).join(' '));
    if (item.unclear) line.append(' (unclear - not read for sure)');
    // The written instructions stay in the record (refill timing only) - not shown
    // here; only whether a daily count could be read from them.
    if (item.instructions) line.append(el_('span', 'muted small', item.daily_units != null
      ? ` · daily count read from the written instructions: ${item.daily_units}`
      : ' · instructions recorded - no unambiguous daily count'));
    lines.append(line);
  }
  row.append(lines);
  if (rx.valid_until) row.append(el_('p', 'muted small', `Valid until ${rx.valid_until} (as written)`));
  if ((rx.uncertain_fields || []).length) {
    row.append(el_('p', 'small household-status', `Awaiting clarification: ${rx.uncertain_fields.map(f => RX_FIELD_WORDS[f]
      || f.replace('items.', 'medicine ')).join(', ')} not read for sure.`));
  }
  return row;
}

async function rxRefresh(userId = getUserId()) {
  if (!memoryEl.rxList) return;
  if (!userId) { rxReset(); return; }
  if (rxShownFor !== userId) { rxReset(); memoryEl.rxStatus.textContent = 'Loading…'; }
  try {
    const data = await apiFetch('/v1/prescriptions/me');
    if (getUserId() !== userId) return;
    rxShownFor = userId;
    const list = Array.isArray(data.prescriptions) ? data.prescriptions : [];
    memoryEl.rxList.replaceChildren(...list.map(rxItem));
    memoryEl.rxCount.textContent = list.length;
    memoryEl.rxStatus.textContent = list.length ? '' : 'No prescriptions saved yet - attach a photo in the chat.';
    memoryCountsShow();
  } catch (error) {
    if (getUserId() !== userId) return;
    if (rxShownFor !== userId) { memoryEl.rxList.replaceChildren(); memoryEl.rxCount.textContent = '–'; }
    memoryEl.rxStatus.textContent = `Couldn't load prescriptions just now. ${pharmacyError(error)}`;
  }
}

async function rxDelete(rx, row, button) {
  if (!window.confirm("Delete this prescription? This can't be undone.")) return;
  button.disabled = true;
  try {
    await apiFetch(`/v1/prescriptions/me/${encodeURIComponent(rx.id)}`, {method: 'DELETE'});
    row.remove();
    memoryEl.rxCount.textContent = memoryEl.rxList.children.length;
    memoryCountsShow();
  } catch (error) {
    button.disabled = false;
    memoryEl.rxStatus.textContent = `Couldn't delete that just now. ${pharmacyError(error)}`;
  }
}

// ---------- saved addresses (GET/DELETE /v1/addresses/me) ----------
//
// Only addresses the user chose to remember (the location dialog's checkbox) -
// never the device's location. Only the signed-in user's own.
let addrShownFor = null;

function addrReset() {
  addrShownFor = null;
  if (!memoryEl.addrList) return;
  memoryEl.addrList.replaceChildren();
  memoryEl.addrCount.textContent = '0';
  memoryEl.addrStatus.textContent = '';
}

function addrItem(address) {
  const row = el_('article', 'memory-item address-item');
  const head = el_('div', 'memory-head');
  head.append(el_('p', 'memory-text', `${address.label}: ${address.address}${address.pincode ? ` – ${address.pincode}` : ''}`));
  const remove = el_('button', 'icon-btn memory-forget');
  remove.append(icon('trash'));
  remove.type = 'button';
  remove.title = 'Delete this address';
  remove.setAttribute('aria-label', `Delete the address: ${address.label}`);
  remove.onclick = () => memoryDeleteRow(`/v1/addresses/me/${encodeURIComponent(address.id)}`, row, remove,
    memoryEl.addrStatus, `Delete the saved address "${address.label}"?`);
  head.append(remove);
  row.append(head);
  const meta = el_('div', 'memory-meta');
  meta.append(el_('span', 'memory-tag long', 'Long-term'));
  meta.append(el_('span', '', 'Saved by you'));
  if (address.updated_at) meta.append(el_('span', '', orderWhen(address.updated_at)));
  meta.append(el_('span', 'muted', 'Used only when you choose it - not your current location'));
  row.append(meta);
  return row;
}

async function addrRefresh(userId = getUserId()) {
  if (!memoryEl.addrList) return;
  if (!userId) { addrReset(); return; }
  if (addrShownFor !== userId) { addrReset(); memoryEl.addrStatus.textContent = 'Loading…'; }
  try {
    const data = await apiFetch('/v1/addresses/me');
    if (getUserId() !== userId) return;
    addrShownFor = userId;
    const list = Array.isArray(data.addresses) ? data.addresses : [];
    memoryEl.addrList.replaceChildren(...list.map(addrItem));
    memoryEl.addrCount.textContent = list.length;
    memoryEl.addrStatus.textContent = list.length ? ''
      : 'No saved addresses - tick "Remember this address" when you enter one.';
  } catch (error) {
    if (getUserId() !== userId) return;
    if (addrShownFor !== userId) { memoryEl.addrList.replaceChildren(); memoryEl.addrCount.textContent = '–'; }
    memoryEl.addrStatus.textContent = `Couldn't load saved addresses just now. ${pharmacyError(error)}`;
  }
  memoryCountsShow();
}

// ---------- refill schedules (GET/POST/PATCH/DELETE /v1/refill-schedules/me) ----------
//
// Set up by the user from one of their confirmed orders. The estimate comes
// only from the tablets dispensed and the daily dose the user confirms from
// the prescription - shown as unavailable until both are known. A reminder,
// never an order.
let schedShownFor = null;

function schedReset() {
  schedShownFor = null;
  if (!memoryEl.schedList) return;
  memoryEl.schedList.replaceChildren();
  memoryEl.schedCount.textContent = '0';
  memoryEl.schedStatus.textContent = '';
}

function schedItem(schedule) {
  const est = schedule.estimate || {};
  const row = el_('article', 'memory-item sched-item');
  const head = el_('div', 'memory-head');
  const who = schedule.patient?.kind === 'member' ? ` - for ${schedule.patient.label}` : '';
  head.append(el_('p', 'memory-text', `${schedule.medicine}${who}`));
  const remove = el_('button', 'icon-btn memory-forget');
  remove.append(icon('trash'));
  remove.type = 'button';
  remove.title = 'Delete this refill schedule';
  remove.setAttribute('aria-label', `Delete the refill schedule: ${schedule.medicine}`);
  remove.onclick = () => memoryDeleteRow(`/v1/refill-schedules/me/${encodeURIComponent(schedule.id)}`, row, remove,
    memoryEl.schedStatus, `Delete the refill schedule for ${schedule.medicine}?`);
  head.append(remove);
  row.append(head);
  const meta = el_('div', 'memory-meta');
  meta.append(el_('span', 'memory-tag long', 'Long-term'));
  meta.append(el_('span', '', schedule.source === 'auto_from_order' ? 'Created automatically from your order' : 'Set up by you'));
  meta.append(el_('span', '', `Dispensed ${schedule.dispensed_date || '?'} · order ${schedule.order_id}`));
  const units = {user_confirmed: 'you confirmed', catalog_pack_size: 'pack size × quantity'}[schedule.units_source];
  meta.append(el_('span', '', schedule.units_dispensed != null ? `${schedule.units_dispensed} units (${units})`
    : 'tablets dispensed: not known'));
  // A schedule set up by the user before daily_source existed: its dose was the user's.
  const daily = {user_confirmed: 'you confirmed', prescription: 'from your prescription'}[schedule.daily_source]
    || (schedule.source === 'user_confirmed_from_order' ? 'you confirmed' : 'recorded');
  meta.append(el_('span', '', schedule.daily_units != null ? `${schedule.daily_units} a day (${daily})` : 'daily dose: not recorded'));
  if (schedule.prescription_valid_until) meta.append(el_('span', '', `prescription valid until ${schedule.prescription_valid_until}`));
  row.append(meta);
  const line = est.status === 'ok'
    ? `Supply lasts about ${est.days_supply} days - runs out around ${est.depletion_date}. Next refill: ${est.next_refill_date}`
      + ` (${est.next_refill_source === 'recorded' ? 'recorded' : 'estimated'}).`
    : `Estimate unavailable - ${est.reason}.`;
  row.append(el_('p', `muted small${est.status === 'ok' ? '' : ' household-status'}`, line));
  for (const note of est.notes || []) row.append(el_('p', 'small household-status', note));
  const reminder = schedule.reminder || {};
  const reminderText = {
    scheduled: `Reminder scheduled - shown in chat from ${reminder.due_from}.`,
    due: `Reminder due - shown in chat when you next open Siru.`,
    delivered: `Reminder delivered${reminder.delivered_at ? ` ${orderWhen(reminder.delivered_at)}` : ''} for the ${reminder.cycle} refill.`,
    failed: `Reminder could not be delivered for the ${reminder.cycle} refill - it will be tried again.`,
    unavailable: `No reminder - ${reminder.reason || 'not enough information'}.`,
  }[reminder.state];
  if (reminderText) row.append(el_('p', 'muted small sched-reminder', reminderText));
  return row;
}

async function schedRefresh(userId = getUserId()) {
  if (!memoryEl.schedList) return;
  if (!userId) { schedReset(); return; }
  if (schedShownFor !== userId) { schedReset(); memoryEl.schedStatus.textContent = 'Loading…'; }
  try {
    const data = await apiFetch('/v1/refill-schedules/me');
    if (getUserId() !== userId) return;
    schedShownFor = userId;
    const list = Array.isArray(data.schedules) ? data.schedules : [];
    memoryEl.schedList.replaceChildren(...list.map(schedItem));
    memoryEl.schedCount.textContent = list.length;
    memoryEl.schedStatus.textContent = list.length ? ''
      : 'No refill schedules yet - they are created automatically from your confirmed orders.';
  } catch (error) {
    if (getUserId() !== userId) return;
    if (schedShownFor !== userId) { memoryEl.schedList.replaceChildren(); memoryEl.schedCount.textContent = '–'; }
    memoryEl.schedStatus.textContent = `Couldn't load refill schedules just now. ${pharmacyError(error)}`;
  }
  memoryCountsShow();
}

async function memoryDeleteRow(path, row, button, status, question) {
  if (!window.confirm(`${question} This can't be undone.`)) return;
  button.disabled = true;
  try {
    await apiFetch(path, {method: 'DELETE'});
    row.remove();
    status.textContent = '';
    await Promise.all([addrRefresh(), schedRefresh()]);
  } catch (error) {
    button.disabled = false;
    status.textContent = `Couldn't delete that just now. ${pharmacyError(error)}`;
  }
}
