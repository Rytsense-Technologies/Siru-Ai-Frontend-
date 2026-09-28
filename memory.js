// The Memory tab of the activity panel (the Tool calls tab is in shopping.js).
//
// Memory belongs to the user, not to a chat session: it survives signing out,
// signing in and starting a new chat. The server extracts it from finished
// turns (multi_agent_framework/memory/extractor.py) and stores it in
// long_term_memories; this tab reads GET /v1/memory/me and can forget one
// item. It never shows chat messages - only the facts kept from them.
const memoryEl = Object.fromEntries([
  "memoryList", "memoryEmpty", "memoryCount", "memoryCountTop", "memoryStatus",
  "memoryConsent", "memoryConsentNote", "stmBadge", "stmSummary", "stmRecent", "ltmBusiness",
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

// Long-term business state: the cart and the orders / bookings confirmed in
// this app, all in the app database - they outlive short-term memory.
async function memoryBusinessRefresh(userId) {
  const rows = [];
  const cart = typeof shop === 'object' ? shop.cart : null;
  if (cart) rows.push(['Cart', cart.items?.length ? `${cart.items.reduce((n, i) => n + (i.qty || 0), 0)} item(s): ${cart.items.map(i => i.name).join(', ')}` : 'empty']);
  try {
    const demo = await apiFetch('/v1/actions/demo');
    if (getUserId() !== userId) return;
    rows.push(['Orders confirmed in this app', String((demo.orders || []).length)]);
    rows.push(['Bookings confirmed in this app', String((demo.bookings || []).length)]);
  } catch (error) {
    rows.push(['Orders and bookings', `unavailable - ${pharmacyError(error)}`]);
  }
  memoryEl.ltmBusiness.replaceChildren(...rows.map(([label, value]) => {
    const li = el_('li', 'ltm-row');
    li.append(el_('span', 'ltm-label', label), el_('span', 'ltm-value', value));
    return li;
  }));
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
  memoryBusinessRefresh(userId);
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
