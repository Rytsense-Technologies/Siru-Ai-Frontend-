// The server owns prices, mutations and orders. Browser state is display-only.
//
// The chat is a list of turns. A turn - typed, a button, or spoken - is one
// block: the user's message, Siru's reply, then that turn's cards (pharmacy
// picked, added to cart) and its bill or order receipt. Everything a turn
// produces goes into its own block, so nothing lands under a later message.
// Which agent and tools handled a turn is in the separate Tool activity panel;
// the reply only links to it.
//
//   typed:  shoppingSubmit -> shoppingTurn -> POST /v1/agents/run -> shoppingTurnFinish
//   voice:  worker "turn.start" -> shoppingTurn;  worker "turn.result" -> shoppingTurnFinish
//           (multi_agent_framework/voice/worker.py, TURN_TOPIC)
let shoppingSessionId = null;
const shop = {
  products: [], cart: null, selected: null, quantity: 1, busy: false,
  generation: 0, selectionPromise: Promise.resolve(),
  selectionError: null, refreshing: false,
  currentUser: null, lastLoadError: null,
  connecting: false, loadError: null,
  // The cart as of the last finished turn (not the background poll) - a turn
  // that changes it gets a bill card.
  billedKey: null, billQueue: Promise.resolve(),
  // turn id -> {id, el, record}: the chat block each turn's output goes into.
  turns: new Map(),
  // The server's bill for the cart as it is ({key, snapshot}) - its delivery
  // fee and store, shown in the cart dialog while the cart is unchanged.
  bill: null,
};
const shopEl = Object.fromEntries([
  "medicineList", "selectedMedicine", "chatMessages", "cartItems", "cartTotal",
  "cartCount", "cartStatus", "clearCartBtn", "placeOrderBtn", "orderDialog", "chatStatus",
  "activityPanel", "activityList", "activityEmpty", "activityBtn", "activityCount", "activityCountTop",
  "activityClose", "liveTranscript", "toolsTab", "memoryTab", "toolsTabBtn", "memoryTabBtn",
  "activityIgnored", "micFilters", "dataTab", "dataTabBtn", "dataList", "dataEmpty", "dataCount", "dataVoiceNote",
  "inspectorSub", "statTools", "statToolsSplit", "statTables", "statWrites", "statModel", "statTokens",
  "guardrails", "guardCount", "guardBlocked", "guardList", "newChatBtn", "guardStatus",
  "aiTab", "aiTabBtn", "aiLayerView", "traceTab", "traceTabBtn", "traceView", "integrationTab", "integrationTabBtn",
  "integrationView",
  "cartDialog", "cartBtn", "cartBill", "cartDialogNote", "cartConfirm", "cartTotalLabel",
].map(id => [id, document.getElementById(id)]));
const money = paise => paise == null ? 'Price unavailable' : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);

// ---------- the cart and checkout, only when needed ----------
//
// The cart is a dialog (index.html #cartDialog), not a panel beside the
// conversation. It opens when a turn changed the cart, or prepared an order,
// payment or refill basket to confirm - and from the Cart button. What it
// shows is the server's cart and bill; nothing is decided here.
const CHECKOUT_ACTIONS = new Set(['order', 'payment', 'refill_basket']);

function cartDialogShow({note = '', confirm = null} = {}) {
  if (!getUserId() || isMerchant()) return;
  shopEl.cartDialogNote.textContent = note;
  if (confirm) {
    // Its own Confirm / Cancel (the chat keeps its copy): a second tap is
    // refused by the server ("already"), never done twice.
    const entry = shoppingConfirmCard(confirm);
    shopEl.cartConfirm.replaceChildren(entry.querySelector('.confirm-card') || entry);
    shopEl.cartConfirm.hidden = false;
  } else if (!shopEl.cartDialog.open) {
    shopEl.cartConfirm.replaceChildren();
    shopEl.cartConfirm.hidden = true;
  }
  if (!shopEl.cartDialog.open) shopEl.cartDialog.showModal();
  cartBillEnsure();
}

// The server's bill (delivery, store) for the cart as it is, when the dialog
// has none yet - e.g. opened from the Cart button after a reload.
async function cartBillEnsure() {
  const cart = shop.cart;
  if (!cart?.items.length || !pharmacyApi.mode || (shop.bill && shop.bill.key === shoppingCartKey(cart))) return;
  const generation = shop.generation;
  try {
    const data = await pharmacyApi.bill();
    if (generation !== shop.generation) return;
    shop.bill = {key: shoppingCartKey(data.cart), snapshot: shoppingBillSnapshot(data)};
    shoppingRenderCart(data.cart);
  } catch {
    // No bill: the dialog keeps showing the items' total, labelled as such.
  }
}

// The bill's store, delivery and address for the cart as it is now.
function cartBillRender(snapshot) {
  const bill = shopEl.cartBill;
  bill.replaceChildren();
  if (snapshot && snapshot.items.length) {
    const lines = [];
    if (snapshot.store) lines.push(['Pharmacy', snapshot.store]);
    if (snapshot.delivery_paise != null) {
      lines.push(['Subtotal', money(snapshot.subtotal_paise)]);
      lines.push(['Delivery', snapshot.delivery_paise === 0 ? 'Free' : money(snapshot.delivery_paise)]);
    }
    if (snapshot.coins_paise) lines.push(['SIRU coins (available)', money(snapshot.coins_paise)]);
    for (const [name, value] of lines) {
      const line = el_('div', 'bill-line');
      line.append(el_('span', '', name), el_('span', '', value));
      bill.append(line);
    }
    if (snapshot.address) {
      const address = el_('p', 'bill-address');
      address.append(icon('pin'), document.createTextNode(snapshot.address));
      bill.append(address);
    }
  }
  bill.hidden = !bill.children.length;
}

// A placed order's receipt, centred - the chat keeps a one-line record of it.
function orderDialogShow(snapshot) {
  document.getElementById('orderSummary').replaceChildren(shoppingBillCard(snapshot));
  if (shopEl.cartDialog.open) shopEl.cartDialog.close();
  if (!shopEl.orderDialog.open) shopEl.orderDialog.showModal();
}

// "commerce_agent" -> "Commerce agent"
function agentLabel(name) {
  if (String(name || '').startsWith('direct_tool:')) return name;
  const words = String(name || '').replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

function el_(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clockTime(time) {
  const now = time ? new Date(time) : new Date();
  const node = el_('time', '', now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
  node.dateTime = now.toISOString();
  return {node, iso: now.toISOString()};
}

// Keep the newest message in view, unless the user scrolled up to read.
// Whether the reader is at the newest message. New content follows only then -
// someone reading an earlier turn stays where they are. Content growing below
// (a reply, a streamed step) doesn't change it; only the reader's scrolling does.
let chatAtBottom = true;
shopEl.chatMessages.addEventListener('scroll', () => {
  const box = shopEl.chatMessages;
  chatAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
}, {passive: true});

function chatScroll(force = false) {
  const box = shopEl.chatMessages;
  if (force || chatAtBottom) box.scrollTop = box.scrollHeight;
}

// One chat entry: "SIRU AI · <agent> · Chat · 3:40 PM" over its content.
function chatEntry({role = 'assistant', label = '', agent = '', time = null, className = ''} = {}) {
  const entry = el_('article', `chat-entry ${role} ${className}`.trim());
  const meta = el_('div', 'message-meta');
  meta.append(el_('strong', '', role === 'user' ? 'User' : 'SIRU AI'));
  if (agent && role === 'assistant') meta.append(el_('span', 'agent-chip', agentLabel(agent)));
  if (label) meta.append(el_('span', '', label));
  const {node, iso} = clockTime(time);
  meta.append(node);
  entry.append(meta);
  return {entry, meta, iso};
}

// A message outside any turn: the greeting, "could you say that again",
// connection notices. Saved in the chat history.
// `kind` 'greeting': the voice greeting - shown and
// kept with the chat, but UI events, never sent to the assistant as history.
function shoppingMessage(text, role = "assistant", source = "text", id = crypto.randomUUID(), savedTime = null, restore = false, kind = null) {
  if (!getUserId()) return document.createElement('div');
  const existing = shopEl.chatMessages.querySelector(`.chat-bubble[data-message-id="${CSS.escape(id)}"]`);
  if (existing) return existing;
  const {entry, iso} = chatEntry({role, label: source === 'voice' ? 'Voice' : 'Chat', time: savedTime});
  const bubble = el_('div', `chat-bubble ${role}`, text);
  bubble.dataset.messageId = id;
  entry.append(bubble);
  shopEl.chatMessages.appendChild(entry);
  if (!restore) chatScroll();
  if (!restore) userSaveMessage(getUserId(), {id, role, text, source, timestamp: iso, ...(kind ? {kind} : {})});
  return bubble;
}

// A notice that isn't repeated when the same one is already the latest message.
function shoppingNotice(text, source = 'text') {
  const last = shopEl.chatMessages.lastElementChild?.querySelector('.chat-bubble');
  if (last && last.textContent === text) return last;
  return shoppingMessage(text, 'assistant', source);
}

// ---------- turns ----------

function turnSave(turn) {
  if (turn.owner) userSaveMessage(turn.owner, turn.record);
}

// ---------- what Siru is doing, live, in the conversation ----------
//
// The same streamed trace steps the inspector draws (SSE `step`, tracing.py),
// shown to the user in their words: only steps the server actually reported,
// each as it runs and as it ended (success, failed, timed out). A turn whose
// only work was answering shows none - the "Siru is working…" line goes as
// before. The inspector keeps the developer detail (inputs, tables, tokens).

// Display names of the real tools (python-assistant graph/tool_dispatch.py and
// merchant_tool_dispatch.py, direct_tools.py, tracing.py's service steps).
// A tool not listed is still shown, by its own name made readable.
const TOOL_LABELS = {
  search_products: 'Searching products', find_prescription_items: 'Matching your prescription',
  browse_store: 'Browsing the store', list_stores: 'Finding stores', view_cart: 'Checking your cart',
  add_to_cart: 'Adding to cart', clear_cart: 'Clearing the cart', remove_from_cart: 'Removing from cart',
  present_options: 'Preparing options', present_card: 'Preparing a card', present_bill: 'Preparing the bill',
  list_orders: 'Checking your orders', track_order: 'Tracking your order', create_order: 'Preparing order',
  save_prescription_for_review: 'Saving your prescription', check_prescription_status: 'Checking your prescription',
  check_valid_prescription: 'Checking your prescription', today_home: 'Loading your day',
  add_household_member: 'Adding a family member', doctor_slots: 'Finding doctor slots',
  select_consult_mode: 'Choosing the consultation', book_appointment: 'Booking the appointment',
  my_appointments: 'Checking your appointments', cancel_appointment: 'Cancelling the appointment',
  list_service_providers: 'Finding service providers', service_slots: 'Finding service slots',
  book_service: 'Booking the service', my_service_bookings: 'Checking your bookings',
  cancel_service_booking: 'Cancelling the booking', refills: 'Checking your refills', rewards: 'Checking your rewards',
  rank_pharmacies: 'Ranking nearby pharmacies', list_doctors: 'Finding doctors',
  connect_pharmacist: 'Connecting a pharmacist', emergency_info: 'Getting emergency help',
  add_product: 'Adding a product', add_offered_product: 'Adding the offered product',
  find_nearby_pharmacy: 'Finding the nearest pharmacy', nearby_pharmacies: 'Finding nearby pharmacies',
  doctors_available: 'Checking available doctors', refill_basket: 'Preparing your refill',
  upi_request: 'Preparing the UPI request', memory_recall: 'Checking your memory', memory_off: 'Pausing memory',
  memory_on: 'Turning memory on', memory_forget: 'Forgetting', dose_safety: 'Checking dose safety',
  record_allergy: 'Recording your allergy', offer_decline: 'Noting your choice',
  rx_readback_confirm: 'Confirming the prescription', rx_readback_decline: 'Noting your correction',
  store_switch_confirm: 'Switching the store',
  confirm_order_by_voice: 'Confirming your order', cancel_order_by_voice: 'Cancelling the prepared order',
  open_cart: 'Opening your cart', open_orders: 'Opening your orders',
  prepare_action: 'Preparing it for your OK', confirm_action: 'Doing what you confirmed',
  notify_contact: 'Alerting your contact', request_upi_payment: 'Requesting the UPI payment',
  extract_prescription: 'Reading the prescription', predict_reorder: 'Checking what you may need again',
  rank_for_user: 'Ranking for you',
  get_catalog_summary: 'Checking the catalog', get_dashboard_summary: 'Loading the dashboard',
  get_earnings: 'Checking earnings', get_low_stock: 'Checking low stock', get_top_items: 'Finding top items',
};
const AGENT_LABELS = {care_agent: 'Health assistant', commerce_agent: 'Shopping assistant',
  booking_agent: 'Booking assistant', merchant_agent: 'Store assistant'};
// Long-term memory steps worth telling the user; the rest (short-term, "considered"...) stay in the inspector.
const ACTIVITY_MEMORY_LABELS = {recalled: 'Checking your memory', saved: 'Saving to memory', forgotten: 'Forgetting', failed: 'Saving to memory'};

function readableName(name) {
  const text = String(name || '').replace(/^direct_tool:/, '').replace(/[_:.-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Working';
}

// A step's line for the user, or null when it isn't one to show.
function activityLabel(step) {
  if (!step) return null;
  if (step.kind === 'tool' || step.kind === 'direct_tool') return TOOL_LABELS[step.name] || readableName(step.name);
  if (step.kind === 'agent') return AGENT_LABELS[step.name] || readableName(step.name);
  if (step.kind === 'llm') return 'Thinking';
  if (step.kind === 'memory' && step.store !== 'redis') return ACTIVITY_MEMORY_LABELS[step.name] || null;
  return null;  // routing, guards, checkpoints, short-term memory: the inspector's
}

// running, success, failed, timeout - as the step said; never assumed.
const ACTIVITY_STATES = {running: 'running', done: 'success', error: 'failed', failed: 'failed', timeout: 'timeout',
  fallback: 'fell back', skipped: 'skipped', unavailable: 'unavailable'};
const ACTIVITY_WORDS = {running: 'running', success: 'done', failed: 'failed', timeout: 'timed out',
  'fell back': 'fell back', skipped: 'skipped', unavailable: 'unavailable', stopped: 'stopped', unfinished: 'not finished'};

function activityState(step) {
  return ACTIVITY_STATES[step.status || 'done'] || 'success';
}

function turnActivityRow(label, state) {
  const row = el_('li', `activity-step state-${state.replace(/\s+/g, '-')}`);
  row.append(el_('span', 'activity-mark', ''), el_('span', 'activity-label', label),
    el_('span', 'activity-state', ACTIVITY_WORDS[state] || state));
  row.querySelector('.activity-mark').setAttribute('aria-hidden', 'true');
  return row;
}

// The turn's activity block: "Siru is working…" until a real step arrives.
function turnActivityNode() {
  const box = el_('details', 'turn-pending turn-activity');
  const summary = el_('summary');
  summary.append(el_('span', 'activity-spinner', ''), el_('span', 'activity-title', 'Siru is working…'),
    el_('span', 'activity-counter', ''));
  summary.querySelector('.activity-spinner').setAttribute('aria-hidden', 'true');
  box.append(summary, el_('ol', 'activity-steps'));
  box.setAttribute('aria-live', 'polite');
  box.open = true;  // its steps show as they come; collapsed once the turn is done
  return box;
}

function turnActivitySummary(box) {
  const rows = [...box.querySelectorAll('.activity-step')];
  const counter = box.querySelector('.activity-counter');
  counter.textContent = rows.length ? `${rows.length} step${rows.length === 1 ? '' : 's'}` : '';
  box.classList.toggle('has-steps', rows.length > 0);
}

// A streamed step: added, or its row updated (same id) as it ends.
function turnActivityStep(turn, step) {
  const box = turn?.el.querySelector('.turn-activity');
  const label = activityLabel(step);
  if (!box || !label) return;
  turn.activity = turn.activity || new Map();
  turn.activityDirect = turn.activityDirect || new Set();
  // A deterministic route's step and the tool call it makes share a name
  // ("clear_cart"): one row, the route's, stands for both.
  if (step.kind === 'direct_tool') turn.activityDirect.add(step.name);
  else if (step.kind === 'tool' && turn.activityDirect.has(step.name)) return;
  const key = step.id ?? `${step.kind}:${step.name}:${turn.activity.size}`;
  const row = turnActivityRow(label, activityState(step));
  const earlier = turn.activity.get(key);
  if (earlier) earlier.replaceWith(row);
  else box.querySelector('.activity-steps').append(row);
  turn.activity.set(key, row);
  turnActivitySummary(box);
  chatScroll();
}

// The answer (or its failure) arrived: collapsed to one line, kept with the
// turn. A step still running then was never reported finished - "stopped" if
// the turn failed, "not finished" otherwise - never counted a success.
function turnActivityFinish(turn, {failed = false, steps = null} = {}) {
  const box = turn.el.querySelector('.turn-activity');
  if (!box) return;
  if (!turn.activity?.size && Array.isArray(steps)) {
    for (const step of steps) turnActivityStep(turn, step);  // a voice turn's steps come with its result
  }
  const rows = [...box.querySelectorAll('.activity-step')];
  if (!rows.length) {
    box.remove();  // nothing real to show
    return;
  }
  for (const row of rows.filter(r => r.classList.contains('state-running'))) {
    row.replaceWith(turnActivityRow(row.querySelector('.activity-label').textContent, failed ? 'stopped' : 'unfinished'));
  }
  const final = [...box.querySelectorAll('.activity-step')];
  const problems = final.filter(r => /state-(failed|timeout|stopped)/.test(r.className)).length;
  box.classList.remove('turn-pending');
  box.classList.add('done', problems || failed ? 'has-problems' : 'all-ok');
  box.open = false;
  box.querySelector('.activity-title').textContent = failed ? 'Stopped' : 'Completed';
  box.querySelector('.activity-counter').textContent = [`${final.length} step${final.length === 1 ? '' : 's'}`,
    problems ? `${problems} with a problem` : ''].filter(Boolean).join(' · ');
  turn.record.activity = final.map(r => ({label: r.querySelector('.activity-label').textContent,
    state: (r.className.match(/state-([\w-]+)/) || [])[1] || 'success'}));
}

// A saved turn's activity, collapsed, as it ended.
function turnActivityRestore(record) {
  const box = turnActivityNode();
  box.classList.remove('turn-pending');
  box.classList.add('done', record.activity.some(a => /failed|timeout|stopped/.test(a.state)) ? 'has-problems' : 'all-ok');
  for (const {label, state} of record.activity) box.querySelector('.activity-steps').append(turnActivityRow(label, state.replace(/-/g, ' ')));
  box.querySelector('.activity-title').textContent = record.status === 'failed' ? 'Stopped' : 'Completed';
  box.querySelector('.activity-counter').textContent = `${record.activity.length} step${record.activity.length === 1 ? '' : 's'}`;
  return box;
}

// The block for a turn: created with the user's message when the turn starts
// (typed: on send; voice: the worker's turn.start). `record` restores a saved one.
function shoppingTurn(turnId, {userText = '', source = 'text', time = null} = {}, record = null) {
  if (shop.turns.has(turnId)) return shop.turns.get(turnId);
  const el = el_('section', 'chat-turn');
  el.dataset.turnId = turnId;
  if (turnId === inspectorTurnId) el.classList.add('inspected');
  const saved = record || {id: turnId, type: 'turn', source, user: userText, status: 'pending',
    timestamp: new Date(time || Date.now()).toISOString(), cards: [], receipts: []};
  if (saved.user) {
    const {entry} = chatEntry({role: 'user', label: saved.source === 'voice' ? 'Voice' : 'Chat', time: saved.timestamp});
    entry.append(el_('div', 'chat-bubble user', saved.user));
    el.append(entry);
  }
  shopEl.chatMessages.appendChild(el);
  // Clicking a turn in the chat shows its trace in the inspector (not its buttons or links).
  el.addEventListener('click', event => {
    if (!event.target.closest('button, a, input, select, textarea, summary')) inspectorSelect(turnId);
  });
  const turn ={id: turnId, el, record: saved, owner: getUserId(), generation: shop.generation};
  shop.turns.set(turnId, turn);
  if (!record) {
    el.append(turnActivityNode());
    turnSave(turn);
    chatScroll(true);
  }
  return turn;
}

// Siru's reply in its turn's block, with the agent and a link to the turn's
// entry in the Tool activity panel.
function turnReply(turn, text, {agent = '', status = 'answered', trace = null, time = null} = {}) {
  const {entry, meta} = chatEntry({agent, label: turn.record.source === 'voice' ? 'Voice' : 'Chat', time});
  if (trace) {
    const tools = (trace.steps || []).filter(step => step.kind === 'tool').length;
    const link = el_('button', 'tools-link');
    link.append(icon('activity'), document.createTextNode(tools ? `${tools} tool${tools === 1 ? '' : 's'}` : 'Activity'));
    link.type = 'button';
    link.title = 'Show in Tool activity';
    link.onclick = () => shoppingShowActivity(turn.id);
    meta.append(link);
  }
  const bubble = el_('div', 'chat-bubble assistant', text);
  if (status === 'failed') bubble.classList.add('message-error');
  entry.append(bubble);
  turn.el.append(entry);
  return bubble;
}

function turnNote(turn, text) {
  turn.el.append(el_('p', 'turn-note', text));
}

// A turn's outcome: its reply, its activity (to the panel), its cards, and
// then its bill or order receipt - all in its own block.
function shoppingTurnFinish(turnId, {status = 'answered', reply = '', agent = '', trace = null, cards = []} = {}) {
  if (!getUserId()) return;
  const turn = shoppingTurn(turnId);
  if (turn.record.status !== 'pending') return;  // one result per turn
  turnActivityFinish(turn, {failed: status === 'failed', steps: trace?.steps || null});
  agent = agent || trace?.agent || '';
  const time = new Date().toISOString();
  Object.assign(turn.record, {status, reply, agent, replied_at: time, has_trace: Boolean(trace),
    cards: Array.isArray(cards) ? cards : []});
  if (reply) turnReply(turn, reply, {agent, status, trace, time});
  else if (status === 'dropped') turnNote(turn, 'Not answered: a newer request was answered first.');
  else if (status === 'failed') turnNote(turn, "Siru couldn't answer this. Please try again.");
  if (trace) shoppingActivityAdd(turn, trace);
  for (const card of turn.record.cards) turnAppend(turn, shoppingUiCard(card, time));
  turnSave(turn);
  // "Open my cart" / "open my orders" (the pre-router's open_view): the window
  // opens only on such an explicit request - every other cart or order answer
  // stays in the chat, with its Confirm card there (Open Cart shows it too).
  const open = turn.record.cards.find(card => card?.kind === 'open_view');
  if (open && status === 'answered' && turn.owner === getUserId()) {
    if (open.view === 'orders') shoppingOrders();
    else cartDialogShow({confirm: shoppingPendingCheckout()});
  }
  chatScroll();
  const placed = (trace?.steps || []).find(step => step.kind === 'tool' && step.name === 'create_order'
    && step.status === 'done' && step.result?.status === 'placed');
  // A turn can teach Siru something new (memory/extractor.py). Voice saves it
  // in the background, so look again shortly after.
  if (status === 'answered') memoryRefresh({delayed: true});
  if (status === 'answered') return shoppingTurnReceipts(turn, placed?.result || null);
}

function turnAppend(turn, entry) {
  if (entry) turn.el.append(entry);
}

// ---------- shelf, selection, cart ----------

function shoppingStatus() {
  const voice = el.voiceStatus.textContent;
  shopEl.chatStatus.textContent = shop.busy || /processing|thinking/i.test(voice) ? 'Processing...'
    : /speaking/i.test(voice) ? 'Speaking...'
    : /listening/i.test(voice) ? 'Listening...'
    : /connecting/i.test(voice) || (!pharmacyApi.mode && shop.connecting) ? 'Connecting...'
    : !pharmacyApi.mode && shop.loadError ? 'Pharmacy offline' : 'Ready';
  shopEl.chatStatus.classList.toggle('active', shopEl.chatStatus.textContent !== 'Ready');
}

// What the user is saying right now (voice), above the input - not a chat message.
function shoppingLivePreview(text) {
  shopEl.liveTranscript.textContent = text || '';
  shopEl.liveTranscript.hidden = !text;
}

// The catalog's names, ids and image addresses are data (safe-dom.js): these
// rows are built with DOM calls, never an HTML string.
function shoppingProductCard(p) {
  const name = String(p.name ?? '');
  const selected = shop.selected === p.id;
  const card = el_('article', selected ? 'medicine-card selected' : 'medicine-card');
  card.dataset.id = String(p.id ?? '');
  const select = el_('button', 'select-product');
  select.type = 'button';
  select.setAttribute('aria-pressed', String(selected));
  select.setAttribute('aria-label', `Select ${name}`);
  select.append(safeImage(p.image_url, { alt: `Illustration of ${name}`, width: 180, height: 130 }),
    el_('strong', '', name), el_('span', 'muted', p.pack_size ?? ''));
  const price = el_('div', 'medicine-price', `${money(p.price_paise)} `);
  price.append(el_('span', 'muted small', '/ pack'));
  const label = el_('label', 'quantity-label', 'Packs ');
  const quantity = el_('input', 'product-qty');
  Object.assign(quantity, { type: 'number', min: '1', max: '99', step: '1', value: String(selected ? shop.quantity : 1) });
  quantity.setAttribute('aria-label', `Quantity for ${name}`);
  label.append(quantity);
  const add = el_('button', 'add-product', 'Add to cart');
  add.type = 'button';
  card.append(select, price, label, add);
  const validQuantity = () => {
    if (!quantity.reportValidity()) return null;
    return Number(quantity.value);
  };
  select.onclick = () => {
    const qty = validQuantity();
    if (qty) shoppingSelect(p, qty);
  };
  quantity.onchange = () => {
    const qty = validQuantity();
    if (qty) shoppingSelect(p, qty);
  };
  add.onclick = () => {
    const qty = validQuantity();
    if (qty) shoppingSubmit(`Add ${qty} packs of ${name}`);
  };
  return card;
}

function shoppingRenderProducts() {
  shopEl.medicineList.replaceChildren(...shop.products.map(shoppingProductCard));
  shoppingControls();
}

function shoppingSelect(product, qty) {
  const generation = shop.generation;
  shop.selected = product.id;
  shop.quantity = qty;
  shopEl.selectedMedicine.textContent = `Selecting ${product.name}…`;
  shoppingRenderProducts();
  // Serialize quick successive clicks so an older response cannot replace the selection.
  shop.selectionPromise = shop.selectionPromise.catch(() => {}).then(async () => {
    if (generation !== shop.generation) return;
    try {
      await pharmacyApi.select(product.id, qty);
      if (generation !== shop.generation) return;
      shop.selectionError = null;
      if (shop.selected === product.id && shop.quantity === qty) {
        shopEl.selectedMedicine.textContent = `Selected: ${product.name} · ${qty} pack(s). ` +
          (pharmacyApi.mode === 'sandbox' ? `For voice, say “Add ${qty} packs of ${product.name}”.` : 'Say “I want this medicine”.');
      }
    } catch (err) {
      if (generation !== shop.generation) return;
      shop.selectionError = err;
      shopEl.selectedMedicine.textContent = "Selection couldn't be saved. Select the product again before using “this medicine”.";
      // Don't leave voice listening with a stale reference to another medicine.
      await stopVoiceSession();
    }
  });
}

async function shoppingSelectionReady() {
  let pending;
  do {
    pending = shop.selectionPromise;
    await pending;
  } while (pending !== shop.selectionPromise);
  if (shop.selectionError) throw new Error("Select the medicine again to save your selection.");
}

function shoppingControls() {
  const disabled = shop.busy || !shop.cart;
  el.askForm.querySelector('[type="submit"]').disabled = !getUserId() || shop.busy || !pharmacyApi.mode;
  const rxButton = document.getElementById('rxBtn');
  if (rxButton) rxButton.disabled = !getUserId() || shop.busy;
  document.querySelectorAll('.slot-btn').forEach(b => { b.disabled = shop.busy; });
  document.querySelectorAll(".add-product, .remove-product").forEach(b => { b.disabled = disabled; });
  shopEl.clearCartBtn.disabled = disabled || !shop.cart.items.length;
  shopEl.placeOrderBtn.disabled = disabled || !shop.cart.items.length;
  shoppingMarkInCart();
  shoppingStatus();
}

function shoppingRenderCart(cart) {
  if (shop.cart && cart.version < shop.cart.version) return;
  shop.cart = cart;
  if (shop.billedKey === null) shop.billedKey = shoppingCartKey(cart);
  // One compact row per item: name, pack and quantity × price, line total, Remove.
  shopEl.cartItems.replaceChildren(...(cart.items.length ? cart.items.map(shoppingCartRow) : [shoppingEmptyCart()]));
  iconsHydrate(shopEl.cartItems);
  // The bill (delivery, store) while it is for this very cart; else the items' total.
  const bill = shop.bill && shop.bill.key === shoppingCartKey(cart) ? shop.bill.snapshot : null;
  cartBillRender(bill);
  const total = bill?.total_paise ?? cart.total_paise;
  shopEl.cartTotal.textContent = money(total);
  // Without the server's bill it is the items only - no delivery - and says so.
  shopEl.cartTotalLabel.textContent = bill || !cart.items.length ? 'Total' : 'Items total';
  const count = cart.items.reduce((n, item) => n + item.qty, 0);
  shopEl.cartCount.textContent = count;
  shopEl.cartBtn.setAttribute('aria-label', `Cart, ${count} item${count === 1 ? '' : 's'}`);
  shopEl.placeOrderBtn.textContent = cart.items.length ? `Place demo order · ${money(total)}` : 'Place demo order';
  if (typeof memoryCartRender === 'function') memoryCartRender(cart);  // the Memory tab's cart card
  shoppingControls();
}

function shoppingEmptyCart() {
  const empty = el_('div', 'empty-cart');
  const art = el_('span', 'empty-cart-icon');
  art.dataset.icon = 'bag';
  art.setAttribute('aria-hidden', 'true');
  empty.append(art, el_('p', '', 'Your cart is empty.'), el_('small', '', "Say or type a medicine's name to get started."));
  return empty;
}

// A cart line from the server - its name, id and image are data, set with DOM calls.
function shoppingCartRow(item) {
  const name = String(item.name ?? '');
  const row = el_('div', 'cart-item');
  const info = el_('div', 'cart-item-info');
  const title = el_('strong', '', name);
  title.title = name;
  info.append(title, el_('span', 'muted small',
    [item.pack_size, `${item.qty} × ${money(item.price_paise)}`].filter(Boolean).join(' · ')));
  const side = el_('div', 'cart-item-side');
  const qty = el_('span', 'cart-qty');
  qty.setAttribute('role', 'group');
  qty.setAttribute('aria-label', `Quantity of ${name}`);
  // − / +: the same commands a user would type, so the server's cart (and
  // its checks) decide - one less of it, or one more of it from this pharmacy.
  const step = (symbol, delta, label, command) => {
    const button = el_('button', 'qty-btn', symbol);
    button.type = 'button';
    button.dataset.id = String(item.id ?? '');
    button.dataset.step = String(delta);
    button.setAttribute('aria-label', `${label} ${name}`);
    button.onclick = () => shoppingSubmit(command);
    return button;
  };
  qty.append(step('−', -1, 'One less', `Remove one ${name}`), el_('span', 'qty-value', String(item.qty)),
    step('+', 1, 'One more', `Add one more ${name} to my cart`));
  const remove = el_('button', 'remove-product link-btn', 'Remove');
  remove.type = 'button';
  remove.dataset.id = String(item.id ?? '');
  remove.setAttribute('aria-label', `Remove ${name}`);
  remove.onclick = () => shoppingSubmit(`Remove ${name}`);
  side.append(el_('strong', '', money(item.line_total_paise)), qty, remove);
  row.append(safeImage(item.image_url, { width: 36, height: 36 }), info, side);
  return row;
}

// ---------- a turn's bill or order receipt ----------

function shoppingCartKey(cart) {
  return cart.items.map(item => `${item.id}:${item.qty}`).sort().join('|');
}

// After a turn is answered: its order receipt, or - when the turn changed the
// cart - the whole cart as a bill, in THAT turn's block. Turns are handled one
// at a time; a reply that changed nothing ("hi", a question) gets no card.
function shoppingTurnReceipts(turn, order) {
  shop.billQueue = shop.billQueue.catch(() => {}).then(async () => {
    if (!getUserId() || !pharmacyApi.mode || turn.owner !== getUserId()) return;
    const generation = shop.generation;
    if (order) {
      // The receipt in the chat (its View button opens the order); no popup.
      const snapshot = shoppingOrderSnapshot(order);
      turnReceipt(turn, snapshot);
      if (ordersEl.dialog.open) shoppingOrders();
    }
    let data;
    try {
      data = await pharmacyApi.bill();
    } catch (err) {
      await shoppingRefresh();
      return;
    }
    if (generation !== shop.generation) return;
    const key = shoppingCartKey(data.cart);
    const snapshot = shoppingBillSnapshot(data);
    shop.bill = {key, snapshot};
    shoppingRenderCart(data.cart);
    shopEl.cartStatus.textContent = 'Cart synced';
    if (key === shop.billedKey) return;
    shop.billedKey = key;
    // The order's receipt already shows what happened to the cart.
    if (!order) turnReceipt(turn, snapshot);
  });
  return shop.billQueue;
}

function turnReceipt(turn, snapshot) {
  const time = new Date().toISOString();
  turn.el.append(shoppingBillMessage(snapshot, time));
  turn.record.receipts = [...(turn.record.receipts || []), {snapshot, timestamp: time}];
  turnSave(turn);
  chatScroll();
}

// What the card shows, saved as-is in the chat history (a receipt of that moment).
function shoppingBillSnapshot(data) {
  const {cart, storeId, bill} = data;
  const store = shop.products.find(p => p.store_id === storeId)?.store_name
    || pharmacyApi.products.find(p => p.store_id === storeId)?.store_name || '';
  return {
    store, address: data.address || '',
    items: cart.items.map(item => ({
      name: item.name, pack: item.pack_size, qty: item.qty, image_url: item.image_url,
      price_paise: item.price_paise, line_paise: item.line_total_paise,
    })),
    subtotal_paise: bill && !bill.empty ? bill.subtotalPaise : cart.total_paise,
    delivery_paise: bill && !bill.empty ? bill.deliveryPaise : null,
    coins_paise: bill && !bill.empty ? bill.coinsAvailablePaise || null : null,
    total_paise: bill && !bill.empty ? bill.totalPaise : cart.total_paise,
  };
}

// An order the agent placed (create_order's result in the turn's activity), as
// a receipt in the same card as the bill. Never marked stale.
function shoppingOrderSnapshot(order) {
  const image = name => pharmacyApi.imageFor(name);
  return {
    kind: 'order', number: order.orderNumber || '', status: order.orderStatus || 'NEW', store: order.storeName || '',
    address: order.deliveryAddress || '',
    items: (order.items || []).map(item => ({
      name: item.name, pack: item.unit || '', qty: item.qty, image_url: image(item.name),
      price_paise: item.unitPricePaise ?? null,
      line_paise: item.unitPricePaise == null ? null : item.unitPricePaise * item.qty,
    })),
    subtotal_paise: order.subtotalPaise ?? null, delivery_paise: order.deliveryPaise ?? null,
    coins_paise: null, total_paise: order.totalPaise ?? null,
  };
}

// A bill or order receipt in the chat: one line, what happened - the full
// card is in the cart dialog (a bill) or the order dialog (an order).
function shoppingBillMessage(snapshot, time = null) {
  const isOrder = snapshot.kind === 'order';
  const {entry} = chatEntry({label: isOrder ? 'Order' : 'Cart', time, className: 'bill-entry'});
  const count = snapshot.items.reduce((n, item) => n + (item.qty || 0), 0);
  const what = isOrder ? `Order ${snapshot.number} placed`
    : count ? `Cart updated · ${count} item${count === 1 ? '' : 's'}` : 'Your cart is now empty';
  const line = el_('div', isOrder ? 'receipt-line order-line' : 'receipt-line');
  line.append(el_('span', 'receipt-text', [what, count && snapshot.total_paise != null ? money(snapshot.total_paise) : '',
    snapshot.store].filter(Boolean).join(' · ')));
  if (isOrder || count) {
    const open = el_('button', 'link-btn', isOrder ? 'View in My orders' : 'Review cart');
    open.type = 'button';
    open.onclick = isOrder ? () => shoppingOrders() : () => cartDialogShow();
    line.append(open);
  }
  entry.append(line);
  return entry;
}

// The full bill or order receipt (the order dialog's summary).
function shoppingBillCard(snapshot) {
  const isOrder = snapshot.kind === 'order';
  const card = el_('div', isOrder ? 'bill-card order-card' : 'bill-card');
  const title = isOrder ? `Order ${snapshot.number}` : 'Bill';
  card.append(el_('div', 'bill-head', snapshot.store ? `${title} · ${snapshot.store}` : title));
  for (const item of snapshot.items) {
    const row = el_('div', 'bill-item');
    const image = el_('img');
    image.src = safeImageUrl(item.image_url);
    image.alt = '';
    image.width = 44;
    image.height = 44;
    const info = el_('div', 'bill-item-info');
    info.append(el_('strong', '', item.name),
      el_('span', '', [item.pack, `${item.qty} × ${money(item.price_paise)}`].filter(Boolean).join(' · ')));
    row.append(image, info, el_('span', 'bill-amount', money(item.line_paise)));
    card.append(row);
  }
  const lines = [];
  if (snapshot.delivery_paise != null) {
    lines.push(['Subtotal', money(snapshot.subtotal_paise)]);
    lines.push(['Delivery', snapshot.delivery_paise === 0 ? 'Free' : money(snapshot.delivery_paise)]);
  }
  lines.push(['Total', money(snapshot.total_paise)]);
  const summary = el_('div', 'bill-summary');
  for (const [name, value] of lines) {
    const line = el_('div', name === 'Total' ? 'bill-line bill-total' : 'bill-line');
    line.append(el_('span', '', name), el_('span', '', value));
    summary.append(line);
  }
  card.append(summary);
  if (snapshot.address) {
    const address = el_('p', 'bill-address');
    address.append(icon('pin'), document.createTextNode(snapshot.address));
    card.append(address);
  }
  if (isOrder) card.append(el_('p', 'order-note', `Status: ${String(snapshot.status).toLowerCase()}`));
  return card;
}

// ---------- a turn's cards (user_service/ui_cards.py) ----------

function productRow(product, badge) {
  const row = el_('div', 'card-product');
  const image = el_('img');
  image.src = safeImageUrl(product.image_url || pharmacyApi.imageFor(product.name));
  image.alt = '';
  image.width = 44;
  image.height = 44;
  const info = el_('div', 'card-product-info');
  info.append(el_('strong', '', product.name));
  const detail = [product.qty > 1 ? `${product.qty} × ${money(product.pricePaise)}` : '', product.unit].filter(Boolean).join(' · ');
  if (detail) info.append(el_('span', '', detail));
  const side = el_('div', 'card-product-side');
  if (badge) side.append(el_('span', 'stock-badge', badge));
  side.append(el_('span', 'card-price', money(product.pricePaise == null ? null : product.pricePaise * (product.qty || 1))));
  row.append(image, info, side);
  return row;
}

// "Order X": the pharmacy picked for it, the product, and Add to cart.
function shoppingOfferCard(card, time) {
  const {entry} = chatEntry({label: 'Pharmacy', time, className: 'card-entry'});
  const box = el_('div', 'chat-card offer-card');
  box.dataset.product = card.product.name;
  // Shown once the user chose this pharmacy (from the list, or by naming it).
  box.append(el_('div', 'card-eyebrow', 'Your pharmacy'));
  const store = el_('div', 'card-store');
  store.append(Object.assign(el_('span', 'card-store-icon'), {ariaHidden: 'true'}));
  store.lastChild.append(icon('store'));
  const where = el_('div');
  where.append(el_('strong', '', card.pharmacy.name || 'Pharmacy'));
  const facts = [
    card.pharmacy.distanceKm != null ? `${card.pharmacy.distanceKm} km away` : '',
    card.pharmacy.etaMin ? `delivery in ~${card.pharmacy.etaMin} min` : '',
  ].filter(Boolean).join(' · ');
  if (facts) where.append(el_('span', 'muted small', facts));
  store.append(where);
  box.append(store, productRow(card.product, card.product.inStock ? 'In stock' : 'Out of stock'));
  if (card.product.prescriptionRequired) box.append(el_('p', 'card-note warn', 'Needs a valid prescription.'));
  if (card.note) box.append(el_('p', 'card-note', card.note));
  const add = el_('button', 'card-action', 'Add to cart');
  add.type = 'button';
  // "Add it": the offer this card shows - that listing (its product and
  // pharmacy ids), the same as saying "yes". Before, it sent "Add <name> to my
  // cart", which picked the pharmacy again (the cart's, else the nearest) - not
  // necessarily this one. Only the latest offer card can: an older one's offer
  // is gone (the server lets it go on any other turn), so it says so instead.
  add.onclick = () => {
    const offers = [...shopEl.chatMessages.querySelectorAll('.offer-card')];
    if (offers.at(-1) !== box) {
      add.disabled = true;
      box.append(el_('p', 'card-note', 'This offer has been replaced - ask for it again to add it.'));
      return;
    }
    shoppingSubmit('Add it to my cart');
  };
  box.append(add);
  if (card.alternatives?.length) {
    const also = card.alternatives.map(a => `${a.name}${a.distanceKm != null ? ` (${a.distanceKm} km)` : ''} ${money(a.pricePaise)}`);
    box.append(el_('p', 'card-also', `Also at: ${also.join(' · ')}`));
  }
  entry.append(box);
  return entry;
}

// What a turn put in the cart, each item marked "In cart".
function shoppingAddedCard(card, time) {
  const {entry} = chatEntry({label: 'Cart', time, className: 'card-entry'});
  const box = el_('div', 'chat-card added-card');
  box.append(el_('div', 'card-eyebrow', 'Added to your cart'));
  for (const item of card.items) box.append(productRow(item, 'In cart'));
  entry.append(box);
  return entry;
}

// What a Confirm actually did (actions/service.py confirm). A demo order or
// booking lives in this app only, and a sandbox UPI request moves no money:
// each says so, so it is never mistaken for a real SIRU order or payment.
function actionOutcome(data) {
  const again = data.replayed ? 'Already done earlier - nothing was repeated. ' : '';
  if (data.order) {
    const total = data.order.totalPaise != null ? `, ${money(data.order.totalPaise)}` : '';
    return again + (data.order.demo
      ? `Demo order ${data.order.orderNumber}${total} saved in this app only. It was not sent to SIRU: no delivery, no payment.`
      : `Order ${data.order.orderNumber || ''} placed${total}.`);
  }
  if (data.booking) {
    return again + (data.booking.demo
      ? `Demo booking ${data.booking.id} saved in this app only. It was not sent to SIRU, so the doctor won't see it.`
      : 'Booked.');
  }
  if (data.payment) {
    return again + (data.payment.demo
      ? `Sandbox UPI request for ${money(data.payment.amount_paise)} recorded. No money moved and nothing was sent to a bank.`
      : `UPI request sent (${data.payment.status}).`);
  }
  if (data.added || data.skipped) {
    const added = (data.added || []).map(item => item.name);
    const skipped = (data.skipped || []).map(item => item.name);
    return again + [added.length ? `Added to your cart: ${added.join(', ')}. Nothing is ordered yet.` : '',
      skipped.length ? `Not added: ${skipped.join(', ')} (needs a valid prescription or is unavailable).` : '']
      .filter(Boolean).join(' ');
  }
  return again + 'Done.';
}

// A decided Confirm card's outcome, kept on the card in this chat's saved history:
// redrawn after a reload it shows what happened, not live Confirm / Cancel buttons
// for an action that was already decided.
function confirmCardSettle(actionId, text, owner = getUserId()) {
  // Only into the chat of the user who decided it, still signed in.
  if (!owner || !actionId || owner !== getUserId()) return;
  for (const record of userHistory(owner)) {
    const card = (record.cards || []).find(c => c?.kind === 'confirm_action' && c.actionId === actionId);
    if (!card) continue;
    card.settled = text;
    userSaveMessage(owner, record);
  }
}

// Something SIRU prepared (an order, booking, payment request or refill):
// nothing happens until the user taps Confirm here (a traced "tap" turn -> actions.confirm).
function shoppingConfirmCard(card, time) {
  const {entry} = chatEntry({label: 'Needs your OK', time, className: 'card-entry'});
  const box = el_('div', 'chat-card confirm-card');
  box.dataset.actionId = card.actionId || '';
  box.append(el_('div', 'card-eyebrow', card.title || 'Please confirm'));
  for (const row of card.rows || []) {
    const line = el_('div', 'confirm-row');
    line.append(el_('span', '', row.label), el_('strong', '', row.value));
    box.append(line);
  }
  const status = el_('p', 'card-note', card.settled || 'Nothing is done until you tap Confirm.');
  if (card.settled) {  // decided earlier in this chat: its outcome, no buttons
    box.append(status);
    entry.append(box);
    return entry;
  }
  const actions = el_('div', 'confirm-actions');
  const decide = async (decision, button) => {
    // Whose decision this is: the answer is only shown to, and kept for, that
    // user - not whoever is signed in on this device when it arrives.
    const owner = getUserId();
    if (!owner) return;
    actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
    button.textContent = decision === 'confirm' ? 'Confirming…' : 'Cancelling…';
    try {
      // The decision as a traced turn (POST /v1/concierge/turn, input.type "tap" -> actions.confirm /
      // cancel): what it did - the order written to this app's own records - reaches the inspector
      // like any turn's tools and tables. Same outcome as POST /v1/actions/{id}/{decision}.
      // A check-in's Confirm right after sign-in has no chat session yet: it starts one.
      const answer = await concierge.turn({session_id: shoppingEnsureSession(), user_id: owner, channel: 'chat',
        input: {type: 'tap', action_id: card.actionId, decision}, history: [], context: {}});
      if (owner !== getUserId()) return;  // signed out (or someone else signed in) meanwhile
      const data = answer.cards.find(c => c.kind === 'action_result') || null;
      shoppingActivityAdd({id: crypto.randomUUID(), record: {
        user: `${decision === 'confirm' ? 'Confirm' : 'Cancel'}: ${card.title || 'prepared action'}`, source: 'text',
        reply: answer.text, cards: answer.cards}}, answer.trace);
      activityCounts();
      if (!data) {
        // Refused (already decided, expired, not this user's): nothing to retry - say why.
        status.textContent = `${answer.text.replace(/\.$/, '')}. Nothing more was done.`;
        actions.remove();
        confirmCardSettle(card.actionId, status.textContent);
        return;
      }
      status.textContent = decision === 'confirm' ? actionOutcome(data) : 'Cancelled. Nothing was done.';
      actions.remove();
      confirmCardSettle(card.actionId, status.textContent);
      shoppingRefresh();
    } catch (err) {
      if (owner !== getUserId()) return;
      // Already decided or expired (409/410): nothing to retry - say why.
      if (err.status === 409 || err.status === 410 || err.status === 404) {
        status.textContent = `${err.message.replace(/^\d+\s*/, '')}. Nothing more was done.`;
        actions.remove();
        confirmCardSettle(card.actionId, status.textContent);
        return;
      }
      status.textContent = `Couldn't ${decision}: ${pharmacyError(err)}`;
      actions.querySelectorAll('button').forEach(b => { b.disabled = false; });
      button.textContent = decision === 'confirm' ? 'Confirm' : 'Cancel';
    }
  };
  const confirm = el_('button', 'card-action', 'Confirm');
  confirm.type = 'button';
  confirm.onclick = () => decide('confirm', confirm);
  const cancel = el_('button', 'card-action ghost', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => decide('cancel', cancel);
  actions.append(confirm, cancel);
  box.append(status, actions);
  entry.append(box);
  return entry;
}

// ---------- the cart and the orders, in the chat ----------
//
// "What's in my cart?" / "show my orders": the server's own records
// (ui_cards.cart_summary / order_list) drawn with the bill card the cart and
// order windows use. Images: the item's own, else its catalog image, else the
// placeholder (pharmacyApi.imageFor). Nothing here computes a price.

// The latest Confirm card of an order still waiting in this chat (for Open Cart).
function shoppingPendingCheckout() {
  const cards = [...shopEl.chatMessages.querySelectorAll('.confirm-card[data-action-id]')]
    .filter(box => box.querySelector('.confirm-actions'));
  const last = cards[cards.length - 1];
  const record = last && shoppingCardRecord(last.dataset.actionId);
  return record && CHECKOUT_ACTIONS.has(record.action) ? record : null;
}

function shoppingCardRecord(actionId) {
  for (const turn of shop.turns.values()) {
    const found = (turn.record?.cards || []).find(card => card?.kind === 'confirm_action' && card.actionId === actionId);
    if (found) return found;
  }
  return null;
}

function shoppingStoreName(storeId) {
  return shop.products.find(p => p.store_id === storeId)?.store_name
    || pharmacyApi.products.find(p => p.store_id === storeId)?.store_name || '';
}

function shoppingCardActions(buttons) {
  const bar = el_('div', 'card-actions');
  for (const [label, onclick, ghost] of buttons) {
    const button = el_('button', ghost ? 'card-action ghost' : 'card-action', label);
    button.type = 'button';
    button.onclick = onclick;
    bar.append(button);
  }
  return bar;
}

function shoppingCartSummaryCard(card, time) {
  const {entry} = chatEntry({label: 'Cart', time, className: 'card-entry'});
  const box = el_('div', 'chat-card cart-summary-card');
  box.append(el_('div', 'card-eyebrow', 'Cart'));
  if (!(card.items || []).length) {
    box.append(el_('p', 'card-note', 'Your cart is empty.'));
  } else {
    const snapshot = {
      store: shoppingStoreName(card.storeId), address: '',
      items: card.items.map(item => ({
        name: item.name, pack: '', qty: item.qty, image_url: item.imageUrl || pharmacyApi.imageFor(item.name),
        price_paise: item.unitPricePaise, line_paise: item.lineTotalPaise,
      })),
      subtotal_paise: card.subtotalPaise, delivery_paise: card.deliveryPaise ?? null, coins_paise: null,
      total_paise: card.totalPaise ?? card.subtotalPaise,
    };
    box.append(shoppingBillCard(snapshot));
  }
  box.append(shoppingCardActions([
    ['Open Cart', () => cartDialogShow({confirm: shoppingPendingCheckout()})],
    ['Continue Shopping', () => { el.askInput.focus(); }, true],
  ]));
  entry.append(box);
  return entry;
}

const ORDER_SOURCE_NOTE = {demo: 'Demo - saved in this app only', siru: 'SIRU order'};

function shoppingOrderListCard(card, time) {
  const {entry} = chatEntry({label: 'Orders', time, className: 'card-entry'});
  const box = el_('div', 'chat-card order-list-card');
  box.append(el_('div', 'card-eyebrow', card.total > (card.orders || []).length
    ? `Orders · newest ${card.orders.length} of ${card.total}` : 'Orders'));
  if (!(card.orders || []).length) box.append(el_('p', 'card-note', 'No orders yet.'));
  for (const order of card.orders || []) {
    const snapshot = {
      kind: 'order', number: order.number || '', status: ORDER_STATUS_WORDS[order.status] || order.status || '',
      store: order.storeName || '', address: '',
      items: (order.items || []).map(item => ({
        name: item.name, pack: '', qty: item.qty, image_url: item.imageUrl || pharmacyApi.imageFor(item.name),
        price_paise: item.unitPricePaise ?? null,
        line_paise: item.unitPricePaise == null ? null : item.unitPricePaise * item.qty,
      })),
      subtotal_paise: order.subtotalPaise ?? null, delivery_paise: order.deliveryPaise ?? null, coins_paise: null,
      total_paise: order.totalPaise ?? null,
    };
    const bill = shoppingBillCard(snapshot);
    const when = order.createdAt ? new Date(order.createdAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : '';
    bill.append(el_('p', 'muted small order-meta', [ORDER_SOURCE_NOTE[order.source], when].filter(Boolean).join(' · ')));
    bill.append(shoppingCardActions([
      ['View Order', () => orderDialogShow(snapshot)],
      ['Open Orders', () => shoppingOrders(), true],
    ]));
    box.append(bill);
  }
  entry.append(box);
  return entry;
}

// "Open my cart" / "open my orders": the window opens (shoppingTurnFinish);
// the chat keeps a one-line note, not a second copy of it.
function shoppingOpenViewCard(card, time) {
  const {entry} = chatEntry({label: card.view === 'orders' ? 'Orders' : 'Cart', time, className: 'bill-entry'});
  const line = el_('div', 'receipt-line');
  const open = el_('button', 'link-btn', card.view === 'orders' ? 'Open Orders' : 'Open Cart');
  open.type = 'button';
  open.onclick = card.view === 'orders' ? () => shoppingOrders() : () => cartDialogShow({confirm: shoppingPendingCheckout()});
  line.append(el_('span', 'receipt-text', card.view === 'orders' ? 'Your orders window' : 'Your cart window'), open);
  entry.append(line);
  return entry;
}

// An order confirmed by a spoken "yes" to its read-back (actions/spoken_confirm.py):
// the server's confirm result, said as a tap's would be. Every copy of that
// order's Confirm card (the chat's, the cart dialog's) is settled, and the
// cart, the Orders dialog and the Memory tab's order cards are read again.
function shoppingOrderConfirmedCard(card, time) {
  const {entry} = chatEntry({label: 'Order confirmed by voice', time, className: 'card-entry'});
  const box = el_('div', 'chat-card confirm-card');
  const outcome = actionOutcome({order: card.order || {}, replayed: card.replayed});
  box.append(el_('div', 'card-eyebrow', 'Confirmed'), el_('p', 'card-note', outcome));
  entry.append(box);
  if (card.actionId) {
    document.querySelectorAll(`.confirm-card[data-action-id="${CSS.escape(card.actionId)}"]`).forEach(other => {
      other.querySelector('.confirm-actions')?.remove();
      const note = other.querySelector('.card-note');
      if (note) note.textContent = `Confirmed by voice. ${outcome}`;
    });
  }
  queueMicrotask(() => {
    shoppingRefresh();
    if (ordersEl.dialog.open) shoppingOrders();
  });
  return entry;
}

// A proactive check-in (proactive/checkins.py), with its prepared basket if any.
function shoppingCheckinCard(card, time) {
  const {entry} = chatEntry({label: 'Check-in', time, className: 'card-entry'});
  const box = el_('div', 'chat-card checkin-card');
  box.append(el_('p', '', card.text || ''));
  entry.append(box);
  if (card.action) box.append(shoppingConfirmCard(card.action, time).querySelector('.confirm-card'));
  return entry;
}

// "Which doctors are available tomorrow?": each doctor's real open slots
// (the doctor_slots tool). Tapping a time only prepares the booking
// (POST /v1/actions/bookings) - its confirm card, in a turn of its own, books it.
function shoppingDoctorSlotsCard(card, time) {
  const {entry} = chatEntry({label: 'Doctors', time, className: 'card-entry'});
  const box = el_('div', 'chat-card doctor-slots-card');
  box.append(el_('div', 'card-eyebrow', `Open slots · ${card.dateLabel || card.date}`));
  for (const doctor of card.doctors || []) {
    const row = el_('div', 'doctor-row');
    const who = el_('div', 'card-store');
    who.append(el_('span', 'card-store-icon'));
    who.lastChild.append(icon('doctor'));
    const name = el_('div');
    name.append(el_('strong', '', doctor.name || 'Doctor'));
    if (doctor.specialty) name.append(el_('span', 'muted small', doctor.specialty));
    who.append(name);
    const times = el_('div', 'slot-buttons');
    for (const slot of doctor.slots || []) {
      const button = el_('button', 'card-action ghost slot-btn', slot.label);
      button.type = 'button';
      button.onclick = () => shoppingPrepareBooking(doctor, slot, card.dateLabel || card.date);
      times.append(button);
    }
    row.append(who, times);
    box.append(row);
  }
  box.append(el_('p', 'card-note', 'Tapping a time only prepares the booking. You confirm it next.'));
  entry.append(box);
  return entry;
}

// A buyer tool's own card (backend ui_cards.from_agent_cards): list_doctors,
// emergency_info, connect_pharmacist, ... - header / paragraph / note / list /
// actions blocks. Text only, never HTML. A button sends its `value` as the
// next message - the same as typing it, so every guard still applies - and
// only for intents that ask for something; ones that change or cancel
// something are left to the chat, where they are confirmed. A call is a tel: link.
const UI_CARD_REQUEST_INTENTS = new Set(['book_appointment', 'book_service', 'select_pharmacy',
  'check_prescription_status', 'my_appointments', 'my_service_bookings', 'shop']);
const UI_CARD_CALL_INTENTS = new Set(['call', 'call_emergency']);

function uiCardButton(action) {
  if (!action || !action.label) return null;
  const tel = String(action.payload?.tel || '').replace(/[^\d+]/g, '');
  if (UI_CARD_CALL_INTENTS.has(action.intent) && tel) {
    const link = el_('a', `card-action ${action.style === 'danger' ? 'danger' : 'ghost'}`, action.label);
    link.href = `tel:${tel}`;
    return link;
  }
  if (!UI_CARD_REQUEST_INTENTS.has(action.intent) || !action.value) return null;
  const button = el_('button', `card-action ${action.style === 'primary' ? '' : 'ghost'}`.trim(), action.label);
  button.type = 'button';
  button.onclick = () => shoppingSubmit(String(action.value));
  return button;
}

function shoppingToolCard(card, time) {
  const {entry} = chatEntry({label: card.title || 'Siru', time, className: 'card-entry'});
  const box = el_('div', `chat-card ui-card${card.accent ? ` accent-${String(card.accent).replace(/\W/g, '')}` : ''}`);
  if (card.title) box.append(el_('div', 'card-eyebrow', card.title));
  for (const block of card.blocks || []) {
    if (block.type === 'header') {
      box.append(el_('strong', '', block.text || ''));
      if (block.sub) box.append(el_('span', 'muted small', block.sub));
    } else if (block.type === 'paragraph') {
      box.append(el_('p', '', block.text || ''));
    } else if (block.type === 'note') {
      box.append(el_('p', `card-note${block.tone === 'danger' || block.tone === 'warning' ? ' warn' : ''}`, block.text || ''));
    } else if (block.type === 'list') {
      for (const item of block.items || []) {
        const row = el_('div', 'doctor-row');
        const who = el_('div');
        who.append(el_('strong', '', item.title || ''));
        if (item.subtitle) who.append(el_('span', 'muted small', item.subtitle));
        if (item.meta) who.append(el_('span', 'muted small', item.meta));
        row.append(who);
        const button = uiCardButton(item.action);
        if (button) row.append(button);
        box.append(row);
      }
    } else if (block.type === 'details') {
      // What to do while help comes (the emergency card): folded, opened on a tap.
      const more = el_('details', 'card-details');
      more.append(el_('summary', '', block.summary || 'More'));
      const list = el_('ol', 'card-steps');
      for (const item of block.items || []) list.append(el_('li', '', String(item)));
      more.append(list);
      box.append(more);
    } else if (block.type === 'actions') {
      const buttons = (block.buttons || []).map(uiCardButton).filter(Boolean);
      if (buttons.length) {
        const bar = el_('div', 'slot-buttons');
        bar.append(...buttons);
        box.append(bar);
      }
    }
  }
  entry.append(box);
  return entry;
}

// present_options: a question and a button per option; a tap sends the option's value.
function shoppingChoicesCard(card, time) {
  const options = (card.options || []).filter(o => o && o.label && o.value);
  if (!options.length) return null;
  const {entry} = chatEntry({label: 'Choose', time, className: 'card-entry'});
  const box = el_('div', 'chat-card choices-card');
  // The usual pharmacy (from the user's own orders here), shown apart above the nearest list.
  if (options.some(o => o.usual)) box.classList.add('usual-pharmacy-card');
  if (card.question) box.append(el_('p', '', card.question));
  const bar = el_('div', 'slot-buttons');
  for (const option of options) {
    const button = el_('button', 'card-action ghost', option.label);
    button.type = 'button';
    button.onclick = () => shoppingSubmit(String(option.value));
    bar.append(button);
  }
  box.append(bar);
  entry.append(box);
  return entry;
}

async function shoppingPrepareBooking(doctor, slot, dateLabel) {
  if (shop.busy || !getUserId()) return;
  const owner = getUserId();
  const generation = shop.generation;
  const turnId = crypto.randomUUID();
  shop.busy = true;
  shoppingControls();
  const turn = shoppingTurn(turnId, {userText: `Book ${doctor.name}, ${dateLabel} at ${slot.label}`, source: 'text'});
  const reply = 'Please check the booking below and confirm it. Nothing is booked until you do.';
  try {
    const data = await apiFetch('/v1/actions/bookings', {method: 'POST', body: JSON.stringify({
      doctor_code: doctor.code, start_time: slot.startTime, mode: slot.mode || null})});
    if (generation !== shop.generation) {
      // The user changed meanwhile: the prepared booking goes to its owner's history only.
      Object.assign(turn.record, {status: 'answered', reply, cards: [data.card]});
      userSaveMessage(owner, turn.record);
      return;
    }
    shoppingTurnFinish(turnId, {reply, cards: [data.card]});
  } catch (err) {
    if (generation !== shop.generation) return;
    shoppingTurnFinish(turnId, {status: 'failed', reply: `Couldn't prepare that booking. ${pharmacyError(err)}`});
  } finally {
    if (generation === shop.generation) {
      shop.busy = false;
      shoppingControls();
    }
  }
}

// A prescription photo read for the pharmacist (prescriptions/extract.py):
// each medicine with how sure the reading is. Unclear lines are marked, and
// no dose or quantity is ever shown - the pharmacist checks the draft.
function shoppingRxDraftCard(card, time) {
  const {entry} = chatEntry({label: 'Prescription', time, className: 'card-entry'});
  const box = el_('div', 'chat-card rx-draft-card');
  const local = card.prescription?.stored === 'local_draft';
  box.append(el_('div', 'card-eyebrow', local ? 'Draft for pharmacist review · this app only' : 'Sent for pharmacist review'));
  for (const item of card.items || []) {
    const line = el_('div', 'confirm-row');
    const name = [item.name, item.strength].filter(Boolean).join(' ');
    line.append(el_('span', '', name), el_('strong', item.unclear ? 'rx-unclear' : '',
      item.unclear ? `Unclear (${Math.round((item.confidence || 0) * 100)}%)` : `${Math.round((item.confidence || 0) * 100)}% sure`));
    box.append(line);
  }
  box.append(el_('p', 'card-note', 'A pharmacist must verify this. Nothing is ordered from it, and doses are never read off the photo.'));
  entry.append(box);
  return entry;
}

// "Forget my memory": the stored facts, each with its own Forget tap
// (DELETE /v1/memory/me/{id}). Nothing is deleted until the user picks one.
function shoppingMemoryForgetCard(card, time) {
  const {entry} = chatEntry({label: 'Memory', time, className: 'card-entry'});
  const box = el_('div', 'chat-card confirm-card');
  box.append(el_('div', 'card-eyebrow', 'What I remember about you'));
  const status = el_('p', 'card-note', 'Nothing is deleted until you tap Forget.');
  for (const fact of card.facts || []) {
    const line = el_('div', 'confirm-row');
    const forget = el_('button', 'card-action ghost', 'Forget');
    forget.type = 'button';
    forget.setAttribute('aria-label', `Forget: ${fact.text}`);
    forget.onclick = async () => {
      forget.disabled = true;
      forget.textContent = 'Forgetting…';
      try {
        await pharmacyApi.forgetMemory(fact.id);
        forget.replaceWith(el_('strong', '', 'Forgotten'));
        if (typeof memoryRefresh === 'function') memoryRefresh();
      } catch (err) {
        forget.disabled = false;
        forget.textContent = 'Forget';
        status.textContent = `Couldn't forget that: ${pharmacyError(err)}`;
      }
    };
    line.append(el_('span', '', fact.text), forget);
    box.append(line);
  }
  box.append(status);
  entry.append(box);
  return entry;
}

// A card as a chat entry for the caller to place (null for an unknown kind).
function shoppingUiCard(card, time = null) {
  const render = {
    pharmacy_offer: shoppingOfferCard, cart_added: shoppingAddedCard,
    confirm_action: shoppingConfirmCard, checkin: shoppingCheckinCard,
    doctor_slots: shoppingDoctorSlotsCard, rx_draft: shoppingRxDraftCard,
    memory_forget: shoppingMemoryForgetCard, ui: shoppingToolCard, choices: shoppingChoicesCard,
    order_confirmed: shoppingOrderConfirmedCard, cart_summary: shoppingCartSummaryCard,
    order_list: shoppingOrderListCard, open_view: shoppingOpenViewCard,
  }[card?.kind];
  if (!render) return null;
  const entry = render(card, time);
  queueMicrotask(shoppingMarkInCart);
  return entry;
}

// An offer card's button once that medicine is in the cart.
function shoppingMarkInCart() {
  const names = new Set((shop.cart?.items || []).map(item => item.name));
  shopEl.chatMessages.querySelectorAll('.offer-card').forEach(box => {
    const button = box.querySelector('.card-action');
    const inCart = names.has(box.dataset.product);
    button.disabled = inCart || shop.busy;
    button.textContent = inCart ? 'In cart' : 'Add to cart';
  });
}

// ---------- My orders ----------

const ordersEl = {
  dialog: document.getElementById('ordersDialog'),
  list: document.getElementById('ordersList'),
  status: document.getElementById('ordersStatus'),
};

// Order progress, as the track_order tool shows it (python-assistant
// tools/buyer/orders/track_order.py): the same phases and labels. Only the
// status SIRU returns - there is no rider location or ETA to show.
const ORDER_PHASES = [
  ['NEW', 'Placed'], ['ACCEPTED', 'Accepted'], ['PACKING', 'Packing'],
  ['READY', 'Ready'], ['DISPATCHED', 'Out for delivery'], ['DELIVERED', 'Delivered'],
];
const ORDER_ENDED = {REJECTED: 'Rejected', CANCELLED: 'Cancelled', TIMED_OUT: 'Timed out', RETURNED: 'Returned'};
const ORDER_FINAL = new Set(['DELIVERED', 'COMPLETED', ...Object.keys(ORDER_ENDED)]);
const ORDERS_REFRESH_MS = 15000;
let ordersRefreshTimer = null;

function orderTimeline(status) {
  const code = String(status || '').toUpperCase();
  const list = el_('ol', 'order-timeline');
  list.setAttribute('aria-label', 'Order progress');
  if (ORDER_ENDED[code]) {
    list.append(el_('li', 'done', 'Placed'), el_('li', 'current ended', ORDER_ENDED[code]));
    return list;
  }
  const reached = code === 'COMPLETED' ? ORDER_PHASES.length - 1 : ORDER_PHASES.findIndex(([phase]) => phase === code);
  if (reached < 0) return null;  // a status SIRU has that this list doesn't: the badge alone says it
  ORDER_PHASES.forEach(([, label], index) => {
    const step = el_('li', index < reached ? 'done' : index === reached ? 'current' : '', label);
    if (index === reached) step.setAttribute('aria-current', 'step');
    list.append(step);
  });
  return list;
}

// While My orders is open, a moving order is read again every 15 s.
function ordersScheduleRefresh(orders) {
  clearTimeout(ordersRefreshTimer);
  if (!ordersEl.dialog.open || !orders.some(o => !ORDER_FINAL.has(String(o.status || '').toUpperCase()))) return;
  ordersRefreshTimer = setTimeout(() => { if (ordersEl.dialog.open) shoppingOrders({quiet: true}); }, ORDERS_REFRESH_MS);
}
ordersEl.dialog.addEventListener('close', () => clearTimeout(ordersRefreshTimer));

async function shoppingOrders({quiet = false} = {}) {
  if (!getUserId()) return;
  if (!ordersEl.dialog.open) ordersEl.dialog.showModal();
  if (!quiet) ordersEl.status.textContent = 'Loading your orders…';
  try {
    const orders = await pharmacyApi.orders();
    ordersScheduleRefresh(orders);
    ordersEl.list.replaceChildren();
    ordersEl.status.textContent = orders.length ? `${orders.length} order${orders.length === 1 ? '' : 's'}` : 'No SIRU orders yet. Say “Order Dolo 650” to start.';
    for (const order of orders) {
      const box = el_('article', 'order-row');
      const head = el_('div', 'order-row-head');
      head.append(el_('strong', '', order.orderNumber || 'Order'), el_('span', `order-status status-${String(order.status).toLowerCase()}`, String(order.status || '').toLowerCase()));
      const when = order.createdAt ? new Date(order.createdAt).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '';
      box.append(head, el_('span', 'muted small', [order.storeName, when].filter(Boolean).join(' · ')));
      const timeline = orderTimeline(order.status);
      if (timeline) box.append(timeline);
      const items = el_('ul', 'order-items');
      for (const item of order.items || []) items.append(el_('li', '', `${item.name} × ${item.qty || 1}`));
      box.append(items, orderFooter(money(order.orderTotalPaise), order.id, order.orderNumber || 'this order', order.items));
      ordersEl.list.append(box);
    }
  } catch (err) {
    ordersEl.status.textContent = `Couldn't load your orders. ${pharmacyError(err)}`;
  }
  await shoppingDemoRecords();
}

// An order's total and its Re-order button.
function orderFooter(total, orderId, label, items) {
  const foot = el_('div', 'order-foot');
  foot.append(el_('div', 'order-total', `Total ${total}`));
  if (orderId && (items || []).some(item => item.item_id)) {
    const again = el_('button', 'ghost-btn order-again', 'Re-order');
    again.type = 'button';
    again.setAttribute('aria-label', `Re-order ${label}`);
    again.onclick = () => shoppingReorder(orderId, label, again);
    foot.append(again);
  }
  return foot;
}

// Re-order: the order's items and quantities go into the cart again, from the
// same pharmacy (POST /v1/pharmacy/orders/{user}/{order}/reorder - the same
// add_to_cart path as every add: prescription and allergy checks included).
// Nothing is placed: the user checks out as usual.
async function shoppingReorder(orderId, label, button) {
  const userId = getUserId();
  if (!userId || button.disabled) return;
  const path = `/v1/pharmacy/orders/${encodeURIComponent(userId)}/${encodeURIComponent(orderId)}/reorder`;
  const text = button.textContent;
  button.disabled = true;
  button.textContent = 'Adding…';
  const reason = error => String(error?.message || '').replace(/^\d{3}\s*/, '').trim();
  try {
    let result;
    try {
      result = await apiFetch(path, {method: 'POST'});
    } catch (error) {
      if (error.status !== 409 || error.detail?.conflict !== 'cart_store') throw error;
      // A cart holds one pharmacy's items: replacing it is the user's call.
      if (!window.confirm(`${error.detail.message} Continue?`)) {
        ordersEl.status.textContent = 'Re-order cancelled. Your cart was not changed.';
        return;
      }
      result = await apiFetch(`${path}?replace_cart=true`, {method: 'POST'});
    }
    if (getUserId() !== userId) return;
    const added = (result.added || []).map(item => `${item.name} × ${item.qty}`);
    const skipped = (result.skipped || []).map(item => `${item.name} (${item.reason})`);
    const message = added.length
      ? `Added to your cart from ${label}: ${added.join(', ')}.${skipped.length ? ` Not added: ${skipped.join('; ')}.` : ''} Review your cart, then place the order.`
      : `Nothing from ${label} could be added. ${skipped.length ? `Not added: ${skipped.join('; ')}.` : ''}`.trim();
    ordersEl.status.textContent = message;
    shoppingNotice(message);
    await shoppingRefresh();
  } catch (error) {
    ordersEl.status.textContent = [404, 409, 422].includes(error.status) && reason(error)
      ? `Couldn't re-order ${label}: ${reason(error)}`
      : `Couldn't re-order ${label}. ${pharmacyError(error)}`;
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}

// Orders and bookings confirmed in this app when it only reads SIRU data
// (GET /v1/actions/demo): listed apart from the real orders above, and
// labelled - they were never sent to SIRU.
async function shoppingDemoRecords() {
  let data;
  try {
    data = await apiFetch('/v1/actions/demo');
  } catch {
    return;  // an older API without the route: the real orders are still shown
  }
  const orders = data.orders || [];
  const bookings = data.bookings || [];
  if (!orders.length && !bookings.length) return;
  const section = el_('section', 'demo-records');
  section.append(el_('h3', '', 'Demo - saved in this app only'),
    el_('p', 'muted small', 'Not sent to SIRU: no delivery, no payment, and the doctor does not see these bookings.'));
  for (const order of orders) {
    const box = el_('article', 'order-row demo');
    const head = el_('div', 'order-row-head');
    head.append(el_('strong', '', order.id), el_('span', 'order-status', 'demo'));
    const when = order.createdAt ? new Date(order.createdAt).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '';
    box.append(head, el_('span', 'muted small', when));
    const items = el_('ul', 'order-items');
    for (const item of order.items || []) items.append(el_('li', '', `${item.name} × ${item.qty || 1}`));
    box.append(items, orderFooter(money(order.totalPaise), order.id, order.id, order.items));
    section.append(box);
  }
  for (const booking of bookings) {
    const box = el_('article', 'order-row demo');
    const head = el_('div', 'order-row-head');
    head.append(el_('strong', '', booking.metadata?.doctorName || 'Booking'), el_('span', 'order-status', 'demo'));
    const when = booking.startTime ? new Date(booking.startTime).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '';
    box.append(head, el_('span', 'muted small', [booking.metadata?.specialty, when, booking.metadata?.mode].filter(Boolean).join(' · ')));
    section.append(box);
  }
  ordersEl.list.append(section);
}
document.getElementById('ordersBtn').onclick = shoppingOrders;
document.getElementById('cartOrdersBtn').onclick = shoppingOrders;

// ---------- Inspector: what Siru did, per turn (Tool calls), per table (Data) ----------

const ROUTE_LABELS = {
  pre_router: 'Pre-router', fast_path: 'Fast path', llm: 'Supervisor model',
  emergency: 'Emergency safety check', rx_readback: 'Prescription read-back', offer_reply: 'Pharmacy offer reply',
};
const ACTIVITY_LIMIT = 100;
// The tool activity of the session on screen (users.js: a sign-in starts a
// new one), so it matches the chat next to it.
const activityKey = () => `siru_activity_${getUserId()}_${shoppingSessionId}`;

// The chat session: created the moment the user actually says something
// (typed or spoken), never just by signing in. users.js keeps it per tab.
function shoppingEnsureSession() {
  shoppingSessionId = shoppingSessionId || userEnsureSession(getUserId());
  return shoppingSessionId;
}

function activityMs(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '';
  if (ms < 1) return '<1 ms';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function planeBadge(plane) {
  if (!plane) return null;
  return el_('span', `plane plane-${plane === 'ai' ? 'ai' : 'core'}`, plane === 'ai' ? 'AI service' : 'Core API');
}

function tableChips(read = [], written = []) {
  const chips = el_('span', 'table-chips');
  for (const table of written) chips.append(el_('span', 'table-chip write', `${table} W`));
  for (const table of read) if (!written.includes(table)) chips.append(el_('span', 'table-chip', `${table} R`));
  return chips.children.length ? chips : null;
}

// One row: a label column (ROUTE, TOOL, ...), the name, badges, and a detail line.
function inspectorRow(label, {name = '', badges = [], detail = '', time = '', tone = '', extra = null} = {}) {
  const row = el_('li', `trace-row${tone ? ` trace-${tone}` : ''}`);
  row.append(el_('span', 'trace-label', label));
  const body = el_('div', 'trace-body');
  const head = el_('div', 'trace-head');
  head.append(el_('code', 'trace-name', name));
  for (const badge of badges.filter(Boolean)) head.append(badge);
  if (time) head.append(el_('span', 'trace-time', time));
  body.append(head);
  if (detail) body.append(el_('p', 'trace-detail', detail));
  if (extra) body.append(extra);
  row.append(body);
  return row;
}

// A step's status as the server reported it: running, success, failed,
// timeout (or unavailable / skipped for memory). No status: nothing claimed.
const STATUS_LABELS = {done: 'success', error: 'failed', failed: 'failed', timeout: 'timeout', running: 'running',
  fallback: 'fell back', unavailable: 'unavailable', skipped: 'skipped'};

function statusBadge(status) {
  if (!status) return null;
  const label = STATUS_LABELS[status] || status;
  const tone = label === 'failed' ? 'error' : label === 'success' ? 'ok' : label.replace(/\s+/g, '-');
  return el_('span', `trace-status status-${tone}`, label);
}

// Tokens as reported: a provider that sent none is "not reported", never 0.
function tokensText({tokens_in, tokens_out, tokens_cached}) {
  if (tokens_in == null && tokens_out == null) return 'tokens not reported';
  const parts = [`${tokens_in ?? 0} in / ${tokens_out ?? 0} out`];
  if (tokens_cached != null) parts.push(`${tokens_cached} cached`);
  return parts.join(' · ');
}

function modelProvider(name) {
  const provider = String(name || '').split(':')[0];
  return provider === 'openai' ? 'OpenAI' : String(name || '').startsWith('gemini') ? 'Gemini' : '';
}

const MEMORY_STORES = {redis: 'Redis', app_db: 'App database'};

// A trace step (tracing.py) as its row. `calls` are the streamed tool calls
// (plane, tables) of the turn, matched to its tool steps in order.
// `agents` are the turn's agent steps: a tool that started inside one's
// reported window (at_ms .. ended_at_ms) ran in that agent.
function activityStep(step, calls = [], checkpoints = [], agents = []) {
  if (step.kind === 'route') {
    const target = step.next === 'end' ? 'answered directly' : (step.next ? `→ ${step.next}` : '');
    return inspectorRow('ROUTE', {name: ROUTE_LABELS[step.name] || step.name, time: activityMs(step.duration_ms),
      detail: [target, step.intent ? `intent ${step.intent}` : '', step.tool ? `tool ${step.tool}` : ''].filter(Boolean).join(' · ')});
  }
  if (step.kind === 'direct_tool') {
    // A deterministic route's tool, called by the pre-router itself: no agent, no model.
    const fallback = step.status === 'fallback';
    return inspectorRow('DIRECT', {name: `direct_tool:${step.name}`, tone: fallback ? 'warn' : 'direct',
      badges: [el_('span', 'trace-tag', fallback ? 'fell back to the supervisor' : 'no agent · no model')],
      time: activityMs(step.duration_ms)});
  }
  if (step.kind === 'agent') {
    return inspectorRow('AGENT', {name: step.name, badges: [statusBadge(step.status === 'running' ? '' : step.status)],
      time: activityMs(step.duration_ms)});
  }
  if (step.kind === 'llm') {
    const ok = !step.status || step.status === 'done';
    const what = !ok ? (step.error ? `error ${step.error}` : '')
      : step.tool_calls?.length ? `chose ${step.tool_calls.join(', ')}` : step.via === 'buyer' ? 'wrote the answer' : 'answered';
    return inspectorRow('MODEL', {name: step.name, tone: ok ? '' : 'error',
      badges: [modelProvider(step.name) && el_('span', 'trace-tag', modelProvider(step.name)), statusBadge(step.status)],
      time: activityMs(step.duration_ms), detail: [what, ok ? tokensText(step) : ''].filter(Boolean).join(' · ')});
  }
  if (step.kind === 'memory') {
    const unit = step.store === 'redis' ? 'message' : 'fact';
    const counts = [step.count != null ? `${step.count} ${unit}${step.count === 1 ? '' : 's'}` : '',
      step.duplicates ? `${step.duplicates} already known` : '', step.reason].filter(Boolean).join(' · ');
    return inspectorRow('MEMORY', {name: step.name, tone: step.status === 'unavailable' ? 'warn' : '',
      badges: [step.store && el_('span', 'trace-tag', MEMORY_STORES[step.store] || step.store), statusBadge(step.status)],
      detail: counts, extra: tableChips(step.tables_read || [], step.tables_written || [])});
  }
  if (step.kind === 'guard') {
    return inspectorRow('GUARD', {name: step.name, tone: step.verdict === 'pass' ? '' : 'guard',
      badges: [el_('span', 'trace-tag', step.verdict || 'checked')], detail: step.detail || ''});
  }
  if (step.kind === 'checkpoint') {
    // Where the server says it went (this process's memory, or Postgres) - and
    // only the tables it reported, none for memory.
    const cp = checkpoints.shift();
    const store = step.store || cp?.store || '';
    return inspectorRow('STATE', {name: 'checkpoint saved', tone: 'state',
      badges: [store && el_('span', 'trace-tag', store === 'postgres' ? 'Postgres' : 'in memory')],
      detail: step.name ? `thread ${step.name}` : '', extra: tableChips([], cp?.tables_written || step.tables_written || [])});
  }
  if (step.kind === 'data') {
    return inspectorRow('DATA', {name: 'database', tone: 'state',
      extra: tableChips(step.tables_read || [], step.tables_written || [])});
  }
  if (step.kind === 'location') {
    // The nearest-pharmacy ranking (nearby.py): what it measured from and how many
    // stores had coordinates - not a tool call. Outside development: the counts only.
    const none = step.name === 'none';
    const nearest = (step.nearest || []).slice(0, 5)
      .map(s => `${s.store}${s.distance_km != null ? ` ${s.distance_km} km` : ''}`).join(', ');
    return inspectorRow('LOCATION', {name: none ? 'no location' : step.name, tone: none ? 'warn' : 'state',
      badges: [step.stores_located != null
        && el_('span', 'trace-tag', `${step.stores_located} of ${step.stores_queried ?? '?'} stores located`)],
      detail: nearest});
  }
  if (step.kind === 'confirmation') {
    // What a "yes" may act on (offers.py): asked, used, or let go - and why.
    const what = {purchase: 'purchase confirmation', choose_pharmacy: 'pharmacy list'}[step.confirmation]
      || step.confirmation || 'confirmation';
    return inspectorRow('CONFIRM', {name: `${what} ${step.name}`, tone: step.name === 'invalidated' ? 'warn' : 'state',
      badges: [step.reason && el_('span', 'trace-tag', step.reason)],
      detail: [step.product, step.pharmacy].filter(Boolean).join(' · ')});
  }
  if (step.kind === 'transcript') {
    // What the speech recogniser finalised for a voice turn, before anything acted on it.
    return inspectorRow('HEARD', {name: step.via ? `${step.name} · ${step.via}` : step.name,
      badges: [step.overlap && el_('span', 'trace-tag', 'said over Siru'), step.language && el_('span', 'trace-tag', step.language)],
      detail: step.text || ''});
  }
  // a tool
  const index = calls.findIndex(call => call.name === step.name && !call.used);
  const call = index >= 0 ? calls[index] : null;
  if (call) call.used = true;
  const hasIo = Object.keys(step.input || {}).length || step.result !== undefined || step.error || step.result_count != null;
  let io = null;
  if (hasIo) {
    io = el_('details', 'trace-io');
    const data = {input: step.input || {}};
    if (step.result !== undefined) data.result = step.result;
    if (step.result_count != null) data.result_count = step.result_count;
    if (step.error) data.error = step.error;
    io.append(el_('summary', '', 'Input & result'), el_('pre', '', JSON.stringify(data, null, 2)));
  }
  const extra = el_('div', 'trace-extra');
  const chips = tableChips(call?.tables_read || step.tables_read, call?.tables_written || step.tables_written);
  if (chips) extra.append(chips);
  if (io) extra.append(io);
  const agent = step.at_ms == null ? null : agents.find(a => a.at_ms != null && step.at_ms >= a.at_ms
    && (a.ended_at_ms == null || step.at_ms <= a.ended_at_ms));
  return inspectorRow('TOOL', {name: step.name, tone: ['error', 'timeout'].includes(step.status) ? 'error' : '',
    badges: [planeBadge(call?.plane), statusBadge(step.status)], time: activityMs(step.duration_ms ?? call?.ms),
    detail: [step.by === 'model' ? 'called by the model' : 'called directly', agent ? `in ${agent.name}` : '',
      step.at_ms != null ? `at +${activityMs(step.at_ms)}` : ''].filter(Boolean).join(' · '),
    extra: extra.children.length ? extra : null});
}

function traceFooter(trace) {
  const usage = trace.usage || {};
  const models = Object.keys(usage.by_model || {});
  const calls = usage.llm_calls ?? trace.llm_calls ?? 0;
  const cost = usage.cost_inr == null ? (calls ? '₹ not reported' : '₹0')
    : Number(usage.cost_inr) === 0 ? '₹0' : `₹${Number(usage.cost_inr).toFixed(4)}`;
  const foot = el_('div', 'trace-footer');
  const parts = [models.length ? models.join(', ') : 'no model', `${calls} model call${calls === 1 ? '' : 's'}`];
  if (calls) {
    parts.push(tokensText(usage));
    if (usage.tokens_unreported && usage.tokens_in != null) parts.push(`${usage.tokens_unreported} call${usage.tokens_unreported === 1 ? '' : 's'} without token counts`);
  }
  parts.push(activityMs(trace.total_ms), cost);
  for (const part of parts.filter(Boolean)) foot.append(el_('span', '', part));
  if (trace.trace_id) foot.append(el_('code', 'trace-id', trace.trace_id));
  return foot;
}

// One turn's entry: what was asked, who answered, every step, what came out.
function activityEntry({turn_id, user, timestamp, trace, source = 'text', reply = '', card_kinds = []}) {
  const tools = (trace.steps || []).filter(step => step.kind === 'tool');
  const failed = tools.some(step => ['error', 'timeout'].includes(step.status));
  const tables = inspectorTables([{trace}]);
  const panel = el_('details', 'agent-activity');
  panel.dataset.turnId = turn_id;
  const summary = el_('summary');
  const {node} = clockTime(timestamp);
  node.className = 'activity-when';
  node.title = new Date(timestamp).toLocaleString();
  const voice = source === 'voice';
  const top = el_('span', 'activity-top');
  top.append(el_('span', `activity-source${voice ? ' voice' : ''}`, voice ? 'Voice' : 'Chat'), node,
    el_('span', 'activity-time', activityMs(trace.total_ms)));
  const answeredBy = trace.failed
    ? el_('span', 'trace-status status-error', `failed · ${String(trace.error).replace(/_/g, ' ')}`)
    : el_('code', `agent-chip${String(trace.agent || '').startsWith('direct_tool:') ? ' direct' : ''}`, trace.agent || 'supervisor');
  const meta = el_('span', 'activity-meta');
  const reads = tables.filter(t => t.reads && !t.writes).length;
  const writes = tables.filter(t => t.writes).length;
  meta.append(answeredBy, el_('span', `activity-count${failed ? ' has-error' : ''}`,
    tools.length ? `${tools.length} tool call${tools.length === 1 ? '' : 's'}` : 'no tools'),
    el_('span', 'activity-count', tables.length ? `R ${reads} · W ${writes}` : 'no DB access'));
  summary.append(top, el_('span', 'activity-question', user ? `“${user}”` : 'Siru'), meta);
  const calls = (trace.io?.calls || []).map(call => ({...call}));
  const checkpoints = [...(trace.io?.checkpoints || [])];
  const agents = (trace.steps || []).filter(step => step.kind === 'agent');
  const list = el_('ol', 'trace-rows');
  (trace.steps || []).forEach(step => list.append(activityStep(step, calls, checkpoints, agents)));
  if (!tools.length) list.append(el_('li', 'trace-empty', 'No tool calls for this turn.'));
  if (reply) list.append(inspectorRow('OUT', {name: 'text', detail: reply.length > 160 ? `${reply.slice(0, 160)}…` : reply}));
  for (const kind of card_kinds) list.append(inspectorRow('OUT', {name: `card · ${kind}`}));
  const jump = el_('button', 'link-btn activity-jump', 'Show in chat');
  jump.type = 'button';
  jump.onclick = () => shoppingShowTurn(turn_id);
  // Opening a card makes it the inspector's selected turn.
  panel.addEventListener('toggle', () => { if (panel.open && inspectorTurnId !== turn_id) inspectorSelect(turn_id); });
  panel.append(summary, list, traceFooter(trace));
  if (trace.truncated) panel.append(el_('p', 'muted small', 'Inputs and results were too large to send over voice.'));
  panel.append(jump);
  return panel;
}

// Speech the worker's gate ignored as background (worker.py "noise"): an
// inspector entry only, so what is being filtered can be seen. Never a chat
// message - that is the point of ignoring it.
const NOISE_REASONS = {
  empty: 'nothing said', filler: 'filler sound', mixed_script: 'two languages at once',
  unsupported_language: 'language not supported', short_foreign_fragment: 'stray words, another language',
};

function noiseEntry({noise_id, text, reason, at}) {
  const panel = el_('details', 'agent-activity activity-ignored');
  panel.dataset.noiseId = noise_id;
  const summary = el_('summary');
  const {node} = clockTime(at ? at * 1000 : Date.now());
  node.className = 'activity-when';
  const top = el_('span', 'activity-top');
  top.append(el_('span', 'activity-source voice', 'Voice'), node, el_('span', 'trace-status status-ignored', 'ignored'));
  summary.append(top, el_('span', 'activity-question', text ? `“${text}”` : 'background sound'),
    el_('span', 'activity-meta', NOISE_REASONS[reason] || reason));
  panel.append(summary, el_('p', 'muted small', 'Heard, but not treated as a request: no agent ran, nothing was said.'));
  return panel;
}

function shoppingNoiseEvent(message) {
  shopEl.activityList.prepend(noiseEntry(message));
  const saved = userRead(activityKey(), []);
  userWrite(activityKey(), [...saved, {...message, kind: 'noise'}].slice(-ACTIVITY_LIMIT));
  activityCounts();
}

// Every table the conversation's tools read or wrote (from their streamed
// tool_result / checkpoint events), for the Data tab and the header.
function inspectorTables(items) {
  const tables = new Map();
  const touch = (name, write, tool, plane) => {
    const row = tables.get(name) || {name, reads: 0, writes: 0, tools: new Set(), planes: new Set()};
    row[write ? 'writes' : 'reads'] += 1;
    if (tool) row.tools.add(tool);
    if (plane) row.planes.add(plane);
    tables.set(name, row);
  };
  for (const item of items) {
    for (const call of item.trace?.io?.calls || []) {
      // Where each table is (the SIRU platform's database or this app's own), as the server said.
      const plane = table => call.table_planes?.[table] || call.plane;
      for (const table of call.tables_written || []) touch(table, true, call.name, plane(table));
      for (const table of call.tables_read || []) if (!(call.tables_written || []).includes(table)) touch(table, false, call.name, plane(table));
    }
    for (const cp of item.trace?.io?.checkpoints || []) for (const table of cp.tables_written || []) touch(table, true, 'checkpointer', 'ai');
    // Tables touched outside any tool (the cart saved after the agent), as observed.
    for (const data of item.trace?.io?.data || []) {
      for (const table of data.tables_written || []) touch(table, true, 'turn', data.table_planes?.[table]);
      for (const table of data.tables_read || []) if (!(data.tables_written || []).includes(table)) touch(table, false, 'turn', data.table_planes?.[table]);
    }
    // Memory: long-term facts (app database) and this conversation's recent turns (Redis).
    for (const step of (item.trace?.steps || []).filter(step => step.kind === 'memory')) {
      for (const table of step.tables_written || []) touch(table, true, `memory ${step.name}`, step.table_planes?.[table] || 'ai');
      for (const table of step.tables_read || []) touch(table, false, `memory ${step.name}`, step.table_planes?.[table] || 'ai');
      if (step.store === 'redis' && step.status === 'done' && step.name !== 'short-term empty') {
        touch('redis · short-term conversation', step.name === 'short-term saved', 'short-term memory', 'ai');
      }
    }
  }
  return [...tables.values()].sort((a, b) => (b.writes > 0) - (a.writes > 0) || a.name.localeCompare(b.name));
}

function dataRow(t) {
  const row = el_('div', `data-row${t.writes ? ' written' : ''}`);
  const head = el_('div', 'data-head');
  head.append(el_('code', 'data-name', t.name));
  for (const plane of t.planes) head.append(planeBadge(plane));
  const counts = el_('span', 'data-counts');
  if (t.reads) counts.append(el_('span', 'table-chip', `R ${t.reads}`));
  if (t.writes) counts.append(el_('span', 'table-chip write', `W ${t.writes}`));
  head.append(counts);
  row.append(head, el_('p', 'data-tools', [...t.tools].join(' · ')));
  return row;
}

function dataRender(items) {
  const tables = inspectorTables(items);
  shopEl.dataList.replaceChildren(...tables.map(dataRow));
  shopEl.dataEmpty.hidden = tables.length > 0;
  shopEl.dataCount.textContent = tables.length;
  shopEl.dataVoiceNote.hidden = !items.some(item => item.trace && !item.trace.io && item.source === 'voice');
  return tables;
}

// The header: this conversation's requests, tool calls, tables and model use.
function inspectorSummary() {
  const items = getUserId() ? userRead(activityKey(), []).filter(item => item.kind !== 'noise' && item.trace) : [];
  const tables = dataRender(items);
  const steps = items.flatMap(item => item.trace.steps || []);
  const tools = steps.filter(step => step.kind === 'tool');
  const direct = tools.filter(step => step.by !== 'model').length;
  const model = items.reduce((n, item) => n + (item.trace.usage?.llm_calls ?? item.trace.llm_calls ?? 0), 0);
  // Only what providers reported: calls without token counts are said, not zeroed.
  const reported = items.filter(item => (item.trace.usage?.llm_calls || 0) > 0 && item.trace.usage?.tokens_in != null);
  const tokens = reported.reduce((n, item) => n + (item.trace.usage.tokens_in || 0) + (item.trace.usage.tokens_out || 0), 0);
  const cached = reported.reduce((n, item) => n + (item.trace.usage.tokens_cached || 0), 0);
  const unreported = items.reduce((n, item) => n + (item.trace.usage?.tokens_unreported || 0), 0);
  guardrailsRender(items);
  aiLayerRender(items);
  traceRender(items);
  shopEl.statTools.textContent = tools.length;
  shopEl.statToolsSplit.textContent = tools.length ? `${direct} direct · ${tools.length - direct} by model` : '';
  shopEl.statTables.textContent = tables.length;
  shopEl.statWrites.textContent = tables.filter(t => t.writes).length;
  shopEl.statModel.textContent = model;
  shopEl.statTokens.textContent = !model ? ''
    : reported.length ? [`${tokens.toLocaleString()} tokens`, cached ? `${cached.toLocaleString()} cached` : '',
      unreported ? `${unreported} call${unreported === 1 ? '' : 's'} not reported` : ''].filter(Boolean).join(' · ')
      : 'tokens not reported';
  const voice = items.filter(item => item.source === 'voice').length;
  shopEl.inspectorSub.textContent = items.length
    ? [`${items.length} request${items.length === 1 ? '' : 's'} in this conversation`, voice ? `${voice} by voice` : ''].filter(Boolean).join(' · ')
    : 'No requests yet in this conversation';
}

// The tab counts requests, and says how much background speech was filtered.
function activityCounts() {
  const entries = shopEl.activityList.children.length;
  const ignored = shopEl.activityList.querySelectorAll('.activity-ignored').length;
  const requests = entries - ignored;
  shopEl.activityEmpty.hidden = entries > 0;
  shopEl.activityCount.textContent = requests;
  shopEl.activityCountTop.textContent = requests;
  shopEl.activityIgnored.textContent = ignored ? `${ignored} background transcript${ignored === 1 ? '' : 's'} ignored` : '';
  shopEl.activityIgnored.hidden = !ignored;
  inspectorSummary();
}

// ---------- Inspector: the selected turn ----------
//
// A turn picked in the chat (or the latest one) is highlighted there and its
// Tool calls card opened - the card itself shows every step of that turn.
let inspectorTurnId = null;

function inspectorSelect(turnId, {tab = null} = {}) {
  inspectorTurnId = turnId;
  for (const node of shopEl.chatMessages.querySelectorAll('.chat-turn.inspected')) node.classList.remove('inspected');
  if (turnId) shopEl.chatMessages.querySelector(`.chat-turn[data-turn-id="${CSS.escape(turnId)}"]`)?.classList.add('inspected');
  for (const entry of shopEl.activityList.querySelectorAll('.agent-activity[data-turn-id]')) {
    entry.classList.toggle('selected', entry.dataset.turnId === turnId);
    if (entry.dataset.turnId !== turnId) continue;
    entry.open = true;
    // Into view within the Tool calls list only - never scrolling the page or the chat.
    const box = shopEl.toolsTab.getBoundingClientRect();
    const at = entry.getBoundingClientRect();
    if (box.height && (at.top < box.top || at.top > box.bottom - 40)) shopEl.toolsTab.scrollTop += at.top - box.top - 8;
  }
  if (tab) panelShow(tab);
}

// ---------- Inspector: guardrails ----------
//
// The safety and policy checks this conversation's turns reported - trace
// steps of kind "guard" (multi_agent_framework/tracing.py): which check, what
// it decided and the short reason the server gave. Never the model's
// reasoning, and never a check that wasn't traced: a turn without a guard
// step shows none here, not a "pass".
const GUARD_LABELS = {
  dose_lock: 'Dose lock', sentence_safety_check: 'Spoken sentence check', emergency_check: 'Emergency check',
  rx_gate: 'Prescription gate', pii_mask: 'Personal data masking', spoken_confirmation: 'Spoken confirmation',
  care_self_care: 'Self-care only (no product offered)', overlap_consent: 'Overlapping speech',
  cart_guard: 'Cart guard', pharmacy_selection: 'Pharmacy selection required', allergy_check: 'Allergy check',
  memory_consent: 'Memory consent', memory_safety: 'Memory safety', tool_refused: 'Tool call refused',
  safety_triage: 'Safety triage', emergency_actions: 'Emergency actions shown', commerce_gate: 'Pharmacy / cart / order gate',
  pharmacy_gate: 'Pharmacy discovery gate', symptom_followup: 'Symptom follow-up', prescription_review: 'Prescription review',
  voice_pause: 'Voice pause (turn joined)',
};
const GUARD_BLOCKS = new Set(['blocked', 'refused', 'declined', 'expired', 'required', 'emergency', 'urgent']);
const GUARD_ERRORS = new Set(['error', 'unavailable', 'failed']);

function guardTone(verdict) {
  if (GUARD_BLOCKS.has(verdict)) return 'block';
  if (GUARD_ERRORS.has(verdict)) return 'error';
  return verdict === 'pass' || verdict === 'confirmed' ? 'pass' : 'note';
}

// The guardrail states a reported decision is shown as (never "passed"
// because a turn merely succeeded): pass, block, note (masked, matched,
// confirmed...), error (unavailable, failed).
function guardCounts(items) {
  const counts = {total: 0, pass: 0, block: 0, note: 0, error: 0};
  for (const item of items) for (const step of item.trace.steps || []) {
    if (step.kind !== 'guard') continue;
    counts.total += 1;
    counts[guardTone(step.verdict)] += 1;
  }
  return counts;
}

function guardrailsRender(items) {
  const c = guardCounts(items);
  shopEl.guardStatus.textContent = !c.total ? 'No guardrail checks reported yet'
    : [`${c.total} guardrail check${c.total === 1 ? '' : 's'}`, c.pass ? `${c.pass} passed` : '',
      c.block ? `${c.block} blocked` : '', c.note ? `${c.note} noted` : '', c.error ? `${c.error} unavailable` : '']
      .filter(Boolean).join(' · ');
  shopEl.guardStatus.classList.toggle('has-block', c.block > 0);
  shopEl.guardStatus.classList.toggle('has-error', c.error > 0);
  const rows = [];
  items.forEach((item, index) => {
    for (const step of item.trace.steps || []) {
      if (step.kind === 'guard') rows.push({step, turn: index + 1, item});
    }
  });
  shopEl.guardrails.hidden = !rows.length;
  shopEl.guardCount.textContent = rows.length;
  const blocked = rows.filter(row => guardTone(row.step.verdict) === 'block').length;
  shopEl.guardBlocked.textContent = blocked ? `${blocked} blocked` : '';
  shopEl.guardList.replaceChildren(...rows.reverse().map(({step, turn, item}) => {
    const li = el_('li', `guard-row guard-${guardTone(step.verdict)}`);
    const head = el_('div', 'guard-head');
    head.append(el_('strong', '', GUARD_LABELS[step.name] || step.name || 'guard'),
      el_('span', `guard-verdict guard-${guardTone(step.verdict)}`, step.verdict || 'checked'));
    li.append(head);
    const where = [`Turn ${turn}`, item.source === 'voice' ? 'voice' : 'chat',
      step.at_ms != null ? `+${activityMs(step.at_ms)}` : ''].filter(Boolean).join(' · ');
    li.append(el_('p', 'guard-meta', where));
    if (step.detail) li.append(el_('p', 'guard-detail', String(step.detail)));
    li.title = item.user ? `“${item.user}”` : '';
    return li;
  }));
}

function activityRender(item) {
  shopEl.activityList.prepend(item.kind === 'noise' ? noiseEntry(item) : activityEntry(item));
  activityCounts();
}

// The turn being answered, drawn step by step as the server streams it (SSE
// `step`, tracing.py) - a step's update (running -> done) replaces its row by
// id. Replaced by the turn's full entry when the answer arrives.
function activityLiveStart(turn) {
  const panel = el_('details', 'agent-activity activity-live');
  panel.open = true;
  panel.dataset.turnId = turn.id;
  const summary = el_('summary');
  const top = el_('span', 'activity-top');
  top.append(el_('span', 'activity-source', 'Chat'), statusBadge('running'));
  summary.append(top, el_('span', 'activity-question', turn.record.user ? `“${turn.record.user}”` : 'Siru'));
  const list = el_('ol', 'trace-rows');
  panel.append(summary, list);
  shopEl.activityList.prepend(panel);
  shopEl.activityEmpty.hidden = true;
  inspectorSelect(turn.id);
  return {panel, list, rows: new Map()};
}

function activityLiveStep(live, step) {
  if (!live?.panel.isConnected || !step) return;
  const row = activityStep(step, [], []);
  const earlier = step.id != null ? live.rows.get(step.id) : null;
  if (earlier) earlier.replaceWith(row);
  else live.list.append(row);
  if (step.id != null) live.rows.set(step.id, row);
}

function activityLiveEnd(live) {
  live?.panel.remove();
}

// A failed turn's trace from its streamed steps: the model calls counted as
// the steps say, tokens only where a provider reported them.
function failedTrace(err, turn) {
  const steps = err.steps;
  const llm = steps.filter(step => step.kind === 'llm');
  const reported = llm.filter(step => step.tokens_in != null || step.tokens_out != null);
  return {
    steps, agent: '', route: '', failed: true, error: err.code || 'failed', trace_id: err.traceId || '',
    total_ms: steps.length ? Math.max(...steps.map(step => Number(step.at_ms) || 0)) : null,
    usage: {llm_calls: llm.length, tokens_unreported: llm.length - reported.length,
      tokens_in: reported.length ? reported.reduce((n, step) => n + (step.tokens_in || 0), 0) : (llm.length ? null : 0),
      tokens_out: reported.length ? reported.reduce((n, step) => n + (step.tokens_out || 0), 0) : (llm.length ? null : 0),
      tokens_cached: null, cost_inr: null,
      by_model: Object.fromEntries(llm.map(step => [step.name, {calls: llm.filter(s => s.name === step.name).length}]))},
  };
}

// A turn's activity: into the panel (newest first) and its own history.
function shoppingActivityAdd(turn, trace) {
  if (!Array.isArray(trace?.steps)) return;
  const item = {turn_id: turn.id, user: turn.record.user, source: turn.record.source || 'text',
    timestamp: new Date().toISOString(), trace, reply: turn.record.reply || '',
    card_kinds: (turn.record.cards || []).map(card => card?.kind).filter(Boolean)};
  const saved = userRead(activityKey(), []).filter(entry => entry.turn_id !== turn.id);
  userWrite(activityKey(), [...saved, item].slice(-ACTIVITY_LIMIT));
  activityRender(item);
  inspectorSelect(turn.id);
}

function activityRestore() {
  shopEl.activityList.replaceChildren();
  if (getUserId()) userRead(activityKey(), []).forEach(activityRender);
  activityCounts();
  inspectorSelect((getUserId() ? userRead(activityKey(), []).filter(item => item.trace).at(-1)?.turn_id : null) || null);
}

function flash(node) {
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

// The reply's tools link: open the panel at that turn's entry.
function shoppingShowActivity(turnId) {
  inspectorSelect(turnId, {tab: 'tools'});
  const entry = shopEl.activityList.querySelector(`.agent-activity[data-turn-id="${CSS.escape(turnId)}"]`);
  if (!entry) return;
  entry.open = true;
  entry.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  flash(entry);
}

// "Show in chat" in the panel: the turn's block.
function shoppingShowTurn(turnId) {
  const turn = shop.turns.get(turnId);
  if (!turn) return;
  // The inspector is a bottom sheet at this width (dashboard.css): close it to show the chat.
  if (window.matchMedia('(max-width: 860px)').matches) shopEl.activityPanel.classList.remove('open');
  turn.el.scrollIntoView({block: 'center', behavior: 'smooth'});
  flash(turn.el);
}

// The panel's tabs: the turn-by-turn log, the tables those turns touched,
// what Siru remembers, how the turns ran (AI layer), each turn's numbers
// (Trace), and what the page is connected to (Integration).
const PANEL_TABS = ['tools', 'data', 'memory', 'ai', 'trace', 'integration'];

function panelShow(tab = 'tools', {toggle = false} = {}) {
  const panel = shopEl.activityPanel;
  const wasOpen = panel.classList.contains('open');
  const showing = PANEL_TABS.find(name => !shopEl[`${name}Tab`].hidden) || 'tools';
  if (toggle && wasOpen && showing === tab) { panel.classList.remove('open'); return; }
  panel.classList.add('open');
  for (const name of PANEL_TABS) {
    shopEl[`${name}Tab`].hidden = name !== tab;
    shopEl[`${name}TabBtn`].setAttribute('aria-selected', String(name === tab));
  }
  if (tab === 'memory') memoryRefresh();
  if (tab === 'data' || tab === 'ai' || tab === 'trace') inspectorSummary();
  if (tab === 'integration') integrationRender();
  if (!wasOpen) panel.scrollIntoView({block: 'nearest', behavior: 'smooth'});
}

shopEl.activityBtn.onclick = () => panelShow('tools', {toggle: true});
shopEl.toolsTabBtn.onclick = () => panelShow('tools');
shopEl.dataTabBtn.onclick = () => panelShow('data');
shopEl.memoryTabBtn.onclick = () => panelShow('memory');
shopEl.activityClose.onclick = () => shopEl.activityPanel.classList.remove('open');
shopEl.aiTabBtn.onclick = () => panelShow('ai');
shopEl.traceTabBtn.onclick = () => panelShow('trace');
shopEl.integrationTabBtn.onclick = () => panelShow('integration');

// ---------- Inspector: AI layer, Trace, Integration ----------
//
// Built only from this conversation's real turns (their traces, as the server
// streamed them) and, for Integration, a live check of the API - never sample
// values. A table with no turns says so.
function inspectorTable(headers, rows, totals = null) {
  const table = el_('table', 'inspector-table');
  const head = el_('tr');
  headers.forEach(h => head.append(el_('th', '', h)));
  table.append(el_('thead'));
  table.tHead.append(head);
  const body = el_('tbody');
  for (const row of rows) {
    const tr = el_('tr');
    row.forEach(cell => tr.append(el_('td', '', cell == null || cell === '' ? '—' : String(cell))));
    body.append(tr);
  }
  if (totals) {
    const tr = el_('tr', 'total');
    totals.forEach(cell => tr.append(el_('td', '', cell == null ? '' : String(cell))));
    body.append(tr);
  }
  table.append(body);
  const wrap = el_('div', 'inspector-table-wrap');
  wrap.append(table);
  return wrap;
}

function sectionHead(title, note = '') {
  const head = el_('div', 'inspector-section-head');
  head.append(el_('h3', '', title));
  if (note) head.append(el_('span', 'muted small', note));
  return head;
}

function turnAgent(item) {
  const agent = String(item.trace.agent || '');
  return agent.startsWith('direct_tool:') ? 'rules (direct tool)' : agent || 'rules';
}

function aiLayerRender(items) {
  const view = shopEl.aiLayerView;
  view.replaceChildren(sectionHead('How a turn flows', 'this app, as built'));
  const flows = [
    ['Chat in the app', 'POST /v1/concierge/turn', 'pre_router', 'care · commerce · booking agent', 'tools (AI service + core API)', 'guardrails', 'SSE back to the app'],
    ['Mic', 'LiveKit room', 'Sarvam speech-to-text', 'pre_router → agents', 'safety check per sentence', 'Sarvam text-to-speech', 'Speaker'],
  ];
  for (const flow of flows) {
    const line = el_('div', 'flow-line');
    flow.forEach((part, i) => { if (i) line.append(el_('i', '', '→')); line.append(el_('span', '', part)); });
    view.append(line);
  }
  view.append(sectionHead('Agents', 'turns in this conversation'));
  const agents = new Map();
  for (const item of items) agents.set(turnAgent(item), (agents.get(turnAgent(item)) || 0) + 1);
  view.append(agents.size ? inspectorTable(['agent', 'turns'], [...agents.entries()].sort((a, b) => b[1] - a[1]))
    : el_('p', 'turn-empty', 'No turns yet in this conversation.'));
  view.append(sectionHead('Models', 'as each turn reported them'));
  const models = new Map();
  for (const item of items) {
    for (const [model, use] of Object.entries(item.trace.usage?.by_model || {})) {
      const m = models.get(model) || {calls: 0};
      m.calls += Number(use?.calls || 0);
      models.set(model, m);
    }
  }
  view.append(models.size ? inspectorTable(['model', 'calls'], [...models.entries()].map(([name, m]) => [name, m.calls]))
    : el_('p', 'turn-empty', 'No model calls reported yet.'));
}

function traceRender(items) {
  const view = shopEl.traceView;
  view.replaceChildren(sectionHead('Turns', 'from each turn\'s trace'));
  if (!items.length) {
    view.append(el_('p', 'turn-empty', 'No turns yet in this conversation.'));
    return;
  }
  let tin = 0, tout = 0, ms = 0, timed = 0, calls = 0;
  const rows = items.map((item, index) => {
    const t = item.trace, usage = t.usage || {};
    const guards = (t.steps || []).filter(s => s.kind === 'guard');
    const held = guards.filter(s => guardTone(s.verdict) !== 'error').length;
    tin += Number(usage.tokens_in || 0); tout += Number(usage.tokens_out || 0); calls += Number(usage.llm_calls ?? t.llm_calls ?? 0);
    if (t.total_ms != null) { ms += Number(t.total_ms); timed += 1; }
    const route = (t.steps || []).find(s => s.kind === 'route');
    return [index + 1, item.source === 'voice' ? 'voice' : 'chat', ROUTE_LABELS[route?.name] || route?.name || t.route || '',
      turnAgent(item), Object.keys(usage.by_model || {}).join(', '), usage.llm_calls ?? t.llm_calls ?? 0,
      usage.tokens_in == null ? '' : `${usage.tokens_in} / ${usage.tokens_out ?? 0}`,
      t.total_ms == null ? '' : activityMs(t.total_ms), guards.length ? `${held}/${guards.length}` : '',
      t.failed ? 'failed' : 'answered'];
  });
  view.append(inspectorTable(['#', 'input', 'route', 'agent', 'model', 'calls', 'tokens in / out', 'latency', 'checks', 'status'],
    rows, [`${items.length} turns`, '', '', '', '', calls, `${tin} / ${tout}`, timed ? `avg ${activityMs(ms / timed)}` : '', '', '']));
  view.append(sectionHead('Guardrail checks', 'by rule - decisions the server reported'));
  const byRule = new Map();
  for (const item of items) for (const step of item.trace.steps || []) {
    if (step.kind !== 'guard') continue;
    const r = byRule.get(step.name) || {pass: 0, block: 0, note: 0, error: 0};
    r[guardTone(step.verdict)] += 1;
    byRule.set(step.name, r);
  }
  view.append(byRule.size
    ? inspectorTable(['rule', 'passed', 'blocked', 'noted', 'unavailable'],
      [...byRule.entries()].map(([name, r]) => [GUARD_LABELS[name] || name, r.pass, r.block, r.note, r.error]))
    : el_('p', 'turn-empty', 'No guardrail checks reported in this conversation.'));
}

// Integration: the API this page talks to, checked now - GET /healthz and
// /readyz (no sign-in, no data) - and the tools and endpoints actually used.
let integrationChecking = null;
async function integrationRender() {
  const view = shopEl.integrationView;
  view.replaceChildren(sectionHead('Backend API', API_BASE));
  const status = el_('div', 'integration-checks');
  status.append(el_('p', 'muted small', 'Checking…'));
  view.append(status);
  const items = getUserId() ? userRead(activityKey(), []).filter(item => item.kind !== 'noise' && item.trace) : [];
  view.append(sectionHead('Tools used in this conversation', 'with where they ran and the tables they touched'));
  const tools = new Map();
  for (const item of items) for (const call of item.trace.io?.calls || []) {
    const t = tools.get(call.name) || {plane: call.plane, calls: 0, tables: new Set()};
    t.calls += 1;
    for (const table of [...(call.tables_read || []), ...(call.tables_written || [])]) t.tables.add(table);
    tools.set(call.name, t);
  }
  view.append(tools.size
    ? inspectorTable(['tool', 'plane', 'calls', 'tables'], [...tools.entries()].map(([name, t]) =>
      [name, t.plane === 'ai' ? 'AI service' : t.plane === 'core' ? 'Core API' : (t.plane || ''), t.calls, [...t.tables].join(', ')]))
    : el_('p', 'turn-empty', 'No tool calls reported yet in this conversation.'));
  view.append(sectionHead('Endpoints this page uses'));
  view.append(inspectorTable(['endpoint', 'for'], [
    ['POST /v1/concierge/turn', 'a chat turn (text/event-stream)'], ['POST /v1/voice/token', 'a LiveKit room token for voice'],
    ['GET /v1/memory/me', 'personal memory'], ['GET /v1/household/me', 'household profiles'],
    ['GET /v1/pharmacy/stores/nearby', 'the Nearby screen'], ['POST /v1/concierge/conversation/new', 'New chat'],
  ]));
  const checking = integrationChecking = Promise.allSettled([
    fetch(`${API_BASE}/healthz`).then(r => r.json().then(body => ({ok: r.ok, body}))),
    fetch(`${API_BASE}/readyz`).then(r => r.json().then(body => ({ok: r.ok, body}))),
  ]);
  const [health, ready] = await checking;
  if (checking !== integrationChecking) return;
  status.replaceChildren();
  const row = (name, state, detail = '') => {
    const line = el_('div', 'integration-row');
    line.append(el_('strong', '', name), el_('span', `guard-verdict guard-${state === 'ok' ? 'pass' : state === 'unknown' ? 'note' : 'error'}`, state));
    if (detail) line.append(el_('span', 'muted small', detail));
    status.append(line);
  };
  if (health.status !== 'fulfilled') row('API', 'unreachable', "couldn't reach the API from this page");
  else row('API', health.value.ok && health.value.body?.status === 'ok' ? 'ok' : 'error', 'GET /healthz');
  if (ready.status !== 'fulfilled') row('Readiness', 'unreachable', 'GET /readyz failed');
  else {
    const checks = ready.value.body?.checks || {};
    const labels = {config: 'Configuration', app_db: 'App database (this app\'s own state)',
      client_db: 'Client database (read-only business data)', short_term_memory: 'Short-term memory (Redis)'};
    for (const [key, label] of Object.entries(labels)) {
      if (key in checks) row(label, checks[key] === 'ok' ? 'ok' : checks[key] === 'off' || checks[key] === 'not_used' ? 'unknown' : String(checks[key]));
    }
    if (ready.value.body?.reason) status.append(el_('p', 'muted small', ready.value.body.reason));
  }
}

// ---------- New chat ----------
//
// A fresh conversation without signing out: a new conversation id - the chat,
// the voice greeting (one per conversation), the pharmacy list and choice,
// short-term memory and checkpoints all belong to it - and the server drops
// what it still held to answer the old one ("yes", "the second one").
// Long-term memory, household profiles, the cart and orders stay. The old
// conversation's messages stay on this device, not shown.
async function shoppingNewChat() {
  const owner = getUserId();
  if (!owner || (typeof isMerchant === 'function' && isMerchant())) return;
  shopEl.newChatBtn.disabled = true;
  try {
    await stopVoiceSession();
    let cleared = true;
    try {
      await apiFetch('/v1/concierge/conversation/new', {method: 'POST', body: '{}'});
    } catch (error) {
      cleared = false;
      console.warn('siru: new conversation - pending answers not cleared on the server', error?.status || '');
    }
    if (getUserId() !== owner) return;
    userStartSession(owner);
    await shoppingResetUser();
    if (!cleared) shoppingNotice("New chat started, but the server couldn't be reached to clear the last conversation's pending questions.");
  } finally {
    shopEl.newChatBtn.disabled = false;
  }
}

shopEl.newChatBtn.onclick = shoppingNewChat;

// ---------- voice turns from the worker (TURN_TOPIC) ----------

// A voice turn's memory result, which arrives after the reply (the worker
// saves in the background): add it to that turn's log and update the tab.
function shoppingMemoryEvent({turn_id, status = 'saved', count = 0, short_term = null}) {
  // Long-term memory (the app database): what the turn taught, if anything.
  // What the worker reported - a count and an outcome; no table is named that it didn't report.
  const steps = [{kind: 'memory', store: 'app_db', status: status === 'failed' ? 'error' : 'done', count,
    name: status === 'failed' ? 'save failed' : (count ? 'saved' : 'nothing new')}];
  // Short-term memory (Redis): the turn joined this conversation's recent turns - as a typed turn's does.
  if (short_term === 'saved' || short_term === 'failed') {
    steps.push({kind: 'memory', store: 'redis', status: short_term === 'saved' ? 'done' : 'error',
      name: short_term === 'saved' ? 'short-term saved' : 'short-term save failed'});
  }
  const saved = userRead(activityKey(), []);
  const item = saved.find(entry => entry.turn_id === turn_id);
  if (item) {
    item.trace.steps = [...(item.trace.steps || []), ...steps];
    userWrite(activityKey(), saved);
    inspectorSummary();
  }
  const rows = shopEl.activityList.querySelector(`.agent-activity[data-turn-id="${CSS.escape(turn_id)}"] .trace-rows`);
  for (const step of steps) rows?.append(activityStep(step));
  if (count) memoryRefresh();
}

// The worker's STT / TTS / model failure (voice/errors.py): the stage and a
// safe reason class, never the provider's own message or a key.
const VOICE_STAGE_NAMES = {stt: 'Speech recognition', tts: 'Spoken replies', llm: 'The assistant model', other: 'Voice'};
const VOICE_REASONS = {
  quota: 'the speech provider account is out of credits or quota',
  auth: "the speech provider rejected the server's credentials",
  unavailable: "the speech provider isn't responding",
};
let voiceErrorShown = '';

function shoppingVoiceError({stage = 'other', reason = 'unavailable', status = null, provider = '', recoverable = false}) {
  console.warn('siru: voice stage failed', {stage, reason, status, provider, recoverable});
  const text = `${VOICE_STAGE_NAMES[stage] || 'Voice'} isn't available: ${VOICE_REASONS[reason] || VOICE_REASONS.unavailable}`
    + `${provider ? ` (${provider})` : ''}.${recoverable ? ' Retrying…' : ' Typed chat still works.'}`;
  setVoiceStatus(text);
  if (text !== voiceErrorShown) shoppingNotice(text, 'voice');
  voiceErrorShown = text;
}

function shoppingVoiceEvent(message) {
  if (!message || !getUserId()) return;
  if (message.type === 'turn.start') {
    // The profile just switched and the page isn't reset yet: the previous user's call.
    if (shop.currentUser !== getUserId()) return;
    console.info('siru: voice transcript received', {turn: message.turn_id, language: message.language_code || null});
    shoppingEnsureSession();
    shoppingLivePreview('');
    shoppingTurn(message.turn_id, {userText: message.user_text, source: 'voice'});
    setVoiceStatus('Processing...');
  } else if (message.type === 'turn.result') {
    // Only a turn this user started since the last profile switch: an earlier
    // user's late result is dropped, never recreated as this user's turn.
    const turn = shop.turns.get(message.turn_id);
    if (!turn || turn.generation !== shop.generation || turn.owner !== getUserId()) {
      console.info('siru: stale voice reply dropped', {turn: message.turn_id});
      return;
    }
    console.info('siru: voice reply generated', {turn: message.turn_id, agent: message.agent || message.trace?.agent || null});
    shoppingTurnFinish(message.turn_id, message);
  } else if (message.type === 'turn.memory') {
    shoppingMemoryEvent(message);
  } else if (message.type === 'noise') {
    shoppingNoiseEvent(message);
  } else if (message.type === 'voice.error') {
    shoppingVoiceError(message);
  } else if (message.type === 'reply' && message.text) {
    const greeting = String(message.reply_id || '').startsWith('greeting-');
    shoppingMessage(message.text, 'assistant', 'voice', message.reply_id, null, false, greeting ? 'greeting' : null);
  }
}

// ---------- typed turns ----------

async function shoppingSubmit(text) {
  if (shop.busy || !getUserId()) return;
  const owner = getUserId();
  const generation = shop.generation;
  const turnId = crypto.randomUUID();
  shoppingEnsureSession();
  shop.busy = true;
  shoppingControls();
  const turn = shoppingTurn(turnId, {userText: text, source: 'text'});
  const live = activityLiveStart(turn);
  try {
    await shoppingEnsureConnected();
    if (generation !== shop.generation) return;
    await shoppingSelectionReady();
    if (generation !== shop.generation) return;
    // Each streamed step: the inspector's live entry and the conversation's activity alike.
    const result = await pharmacyApi.command(text, turnId, step => {
      activityLiveStep(live, step);
      turnActivityStep(turn, step);
    });
    activityLiveEnd(live);
    if (generation !== shop.generation) {
      // The user changed meanwhile: keep the reply in the owner's history only.
      Object.assign(turn.record, {status: 'answered', reply: result.message, agent: result.trace?.agent || ''});
      userSaveMessage(owner, turn.record);
      return;
    }
    await shoppingTurnFinish(turnId, {status: 'answered', reply: result.message, agent: result.trace?.agent,
      trace: result.trace, cards: result.cards});
  } catch (err) {
    activityLiveEnd(live);
    if (generation !== shop.generation) return;
    // A failed turn keeps what it did (the steps streamed before the error) as
    // a failed inspector entry - a timed-out or refused model call included.
    const trace = Array.isArray(err.steps) && err.steps.length ? failedTrace(err, turn) : null;
    shoppingTurnFinish(turnId, {status: 'failed', reply: pharmacyError(err), trace});
    // The agent endpoint has no idempotency contract: never resubmit a
    // possibly committed order after a lost response - check the cart instead.
    const check = el_('button', 'link-btn', 'Check cart');
    check.type = 'button';
    check.onclick = shoppingRefresh;
    turn.el.lastElementChild?.querySelector('.chat-bubble')?.append(check);
    await shoppingRefresh();
  } finally {
    if (generation === shop.generation) {
      shop.busy = false;
      shoppingControls();
    }
  }
}

async function shoppingRefresh() {
  if (shop.refreshing || !getUserId() || isMerchant() || !pharmacyApi.mode) return;
  const generation = shop.generation;
  shop.refreshing = true;
  try {
    const state = await pharmacyApi.state();
    if (generation !== shop.generation) return;
    shoppingRenderCart(state.cart);
    shopEl.cartStatus.textContent = "Cart synced";
  } catch (err) {
    if (generation === shop.generation) {
      shopEl.cartStatus.textContent = `Cart unavailable: ${pharmacyError(err)}`;
      if (!shop.cart) {
        shopEl.cartItems.textContent = 'Your cart could not be loaded. No items have been changed.';
        if (typeof memoryCartRender === 'function') memoryCartRender(null, {failed: pharmacyError(err)});
      }
      if (shop.lastLoadError !== err.message) {
        shoppingNotice(`I couldn't refresh your cart. ${pharmacyError(err)}`);
        shop.lastLoadError = err.message;
      }
    }
  } finally {
    if (generation === shop.generation) shop.refreshing = false;
  }
}

// ---------- restoring the chat ----------

function turnRestore(record) {
  const turn = shoppingTurn(record.id, {}, record);
  const time = record.replied_at || record.timestamp;
  if (record.activity?.length) turn.el.append(turnActivityRestore(record));
  if (record.reply) {
    const trace = record.has_trace ? {steps: userRead(activityKey(), []).find(item => item.turn_id === record.id)?.trace?.steps || []} : null;
    turnReply(turn, record.reply, {agent: record.agent, status: record.status, trace, time});
  } else if (record.status === 'dropped') turnNote(turn, 'Not answered: a newer request was answered first.');
  else if (record.status === 'failed') turnNote(turn, "Siru couldn't answer this. Please try again.");
  else if (record.status === 'pending') turnNote(turn, 'No reply (the connection ended).');
  for (const card of record.cards || []) turnAppend(turn, shoppingUiCard(card, time));
  for (const receipt of record.receipts || []) turn.el.append(shoppingBillMessage(receipt.snapshot, receipt.timestamp));
}

// A message outside any turn (the greeting, a notice) in this session.
function messageRestore(message) {
  if (typeof message.text !== 'string') return;
  // A typed welcome an earlier version saved - no longer shown (the spoken
  // greeting, source 'voice', still is).
  if (message.kind === 'greeting' && message.source !== 'voice') return;
  shoppingMessage(message.text, message.role, message.source, message.id, message.timestamp, true, message.kind || null);
}

async function shoppingResetUser() {
  shop.generation++;
  shop.currentUser = getUserId();
  shoppingSessionId = userSession(getUserId());
  const generation = shop.generation;
  shop.cart = null;
  shop.selected = null;
  shop.quantity = 1;
  shop.busy = false;
  shop.refreshing = false;
  shop.turns.clear();
  shop.lastLoadError = null;
  shop.billedKey = null;
  shop.bill = null;
  shop.billQueue = Promise.resolve();
  window.speechSynthesis?.cancel();
  shop.selectionError = null;
  shop.selectionPromise = Promise.resolve();
  shopEl.orderDialog.close();
  shopEl.cartDialog.close();
  cartBillRender(null);
  shopEl.chatMessages.replaceChildren();
  shoppingLivePreview('');
  shopEl.activityPanel.classList.remove('open');
  activityRestore();
  // This session only. A sign-in starts a new session, so the chat starts
  // empty; earlier sessions are kept on the device, just not shown.
  for (const message of getUserId() ? userHistory(getUserId()) : []) {
    if (message.type === 'turn') turnRestore(message);
    else messageRestore(message);
  }
  memoryRefresh();
  shopEl.chatMessages.scrollTop = shopEl.chatMessages.scrollHeight;
  shopEl.selectedMedicine.textContent = "Select a product to use “this medicine”.";
  shopEl.cartItems.textContent = getUserId() ? 'Loading cart…' : 'Sign in to see your cart.';
  shopEl.cartStatus.textContent = getUserId() ? 'Loading cart…' : 'Not signed in';
  shopEl.cartTotal.textContent = money(0);
  shopEl.cartCount.textContent = "0";
  shopEl.cartBtn.setAttribute('aria-label', 'Cart, 0 items');
  shopEl.placeOrderBtn.textContent = 'Place demo order';
  shoppingRenderProducts();
  await stopVoiceSession();
  if (generation !== shop.generation) return;
  if (!getUserId()) return;
  // The session-open moment (due check-ins) needs only the
  // sign-in, not the pharmacy: it ran only once the catalog had loaded, so the
  // first sign-in after opening the page (catalog not loaded yet) skipped it.
  shoppingOpenSession();
  // Switching profile must not leave the page disconnected: load the pharmacy
  // if it isn't yet (that load then refreshes this user's cart itself).
  if (!pharmacyApi.mode) { initShopping(); return; }
  shop.selectionPromise = pharmacyApi.select(null, 1).catch(err => {
    if (generation === shop.generation) shop.selectionError = err;
  });
  await shop.selectionPromise;
  if (generation !== shop.generation) return;
  await shoppingRefresh();
}

// ---------- things SIRU brings up itself, and prescription photos ----------

// Due check-ins when a session opens (POST /v1/concierge/open, no model
// call): "how is the headache today?", or a refill with its basket prepared -
// never ordered. Each is delivered once by the server, shown as its own turn.
async function shoppingOpenSession() {
  const owner = getUserId();
  if (!owner) return;
  let data;
  try {
    data = await apiFetch('/v1/concierge/open', {method: 'POST', body: JSON.stringify({})});
  } catch {
    return;  // an older API without the route - nothing to bring up
  }
  if (owner !== getUserId()) return;
  // No typed greeting: the chat opens empty and the first message is the
  // user's. Siru greets by voice, when the microphone is first turned on.
  for (const card of data.cards || []) {
    const turnId = crypto.randomUUID();
    shoppingTurn(turnId, {source: 'text'});
    shoppingTurnFinish(turnId, {reply: '', cards: [card]});
  }
}

const rxEl = {button: document.getElementById('rxBtn'), file: document.getElementById('rxFile'),
  preview: document.getElementById('attachPreview'), img: document.getElementById('attachImg'),
  name: document.getElementById('attachName'), remove: document.getElementById('attachRemove')};
// The photo types the server reads (prescriptions/extract.py ALLOWED_MIME_TYPES) and its size limit.
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
// The photo waiting to be sent (pasted or picked), shown above the input until Send - or removed.
let photoPending = null;

function photoAttach(file) {
  if (!file) return;
  if (!PHOTO_TYPES.has(file.type)) {
    shoppingNotice(`That file can't be read (${file.type || 'unknown type'}). Please attach a JPEG, PNG, WebP or HEIC photo.`);
    return;
  }
  if (file.size > PHOTO_MAX_BYTES) {
    shoppingNotice('That photo is larger than 8 MB. Please attach a smaller one.');
    return;
  }
  photoClear();
  photoPending = {file, url: URL.createObjectURL(file)};
  rxEl.img.src = photoPending.url;
  rxEl.name.textContent = file.name && file.name !== 'image.png' ? file.name : 'Pasted photo';
  rxEl.preview.hidden = false;
  // Send works with only the photo: no typed text needed.
  el.askInput.required = false;
  el.askInput.focus();
}

function photoClear() {
  if (photoPending?.url) URL.revokeObjectURL(photoPending.url);
  photoPending = null;
  rxEl.img.removeAttribute('src');
  rxEl.preview.hidden = true;
  el.askInput.required = true;
}

// A photo (a prescription, or a medicine's pack) as a turn: read on the server,
// the medicines read clearly looked up in the catalog - the reply, its cards
// and its trace like any turn. Nothing is ordered from it.
async function shoppingSendPhoto(file) {
  if (!file || shop.busy || !getUserId()) return;
  const generation = shop.generation;
  const turnId = crypto.randomUUID();
  shoppingEnsureSession();
  shop.busy = true;
  shoppingControls();
  const turn = shoppingTurn(turnId, {userText: `Photo: ${file.name && file.name !== 'image.png' ? file.name : 'pasted photo'}`,
    source: 'text'});
  const live = activityLiveStart(turn);
  try {
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error("The photo couldn't be read."));
      reader.readAsDataURL(file);
    });
    const result = await pharmacyApi.photo(image, file.type, step => {
      activityLiveStep(live, step);
      turnActivityStep(turn, step);
    });
    activityLiveEnd(live);
    if (generation !== shop.generation) return;
    await shoppingTurnFinish(turnId, {status: 'answered', reply: result.message, agent: result.trace?.agent,
      trace: result.trace, cards: result.cards});
  } catch (err) {
    activityLiveEnd(live);
    if (generation !== shop.generation) return;
    const trace = Array.isArray(err.steps) && err.steps.length ? failedTrace(err, turn) : null;
    shoppingTurnFinish(turnId, {status: 'failed', reply: `Couldn't read that photo. ${pharmacyError(err)}`, trace});
  } finally {
    if (generation === shop.generation) {
      shop.busy = false;
      shoppingControls();
    }
  }
}

if (rxEl.button) {
  rxEl.button.onclick = () => rxEl.file.click();
  rxEl.file.onchange = () => {
    const [file] = rxEl.file.files;
    rxEl.file.value = '';
    photoAttach(file);
  };
  rxEl.remove.onclick = () => { photoClear(); el.askInput.focus(); };
  // Ctrl+V of an image into the message box attaches it (a pasted text stays text).
  el.askInput.addEventListener('paste', event => {
    const item = [...(event.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    event.preventDefault();
    photoAttach(item.getAsFile());
  });
}

shopEl.clearCartBtn.onclick = () => shoppingSubmit("Clear cart");
// Ordering is a turn like any other: the dialog closes, the chat shows it,
// and a placed order opens its receipt (orderDialogShow).
shopEl.placeOrderBtn.onclick = () => {
  shopEl.cartDialog.close();
  shoppingSubmit("Place order");
};
shopEl.cartBtn.onclick = () => cartDialogShow();
// A confirmation shown in the dialog is only for that moment: the chat keeps its copy.
shopEl.cartDialog.addEventListener('close', () => {
  shopEl.cartConfirm.replaceChildren();
  shopEl.cartConfirm.hidden = true;
});

// The catalog load sets the pharmacy connection (pharmacyApi.mode). It used to
// run once at page start with no retry, so an API that was still starting left
// the page disconnected until a manual reload, and the mic only said "Load the
// pharmacy connection". Every caller now shares one load, and a failed load
// retries on its own.
const SHOPPING_RETRY_MIN_MS = 2000;
const SHOPPING_RETRY_MAX_MS = 30000;
let shoppingLoad = null;
let shoppingRetryTimer = null;
let shoppingRetryDelay = SHOPPING_RETRY_MIN_MS;

function initShopping() {
  // Every pharmacy route needs the signed-in user's token - a buyer's.
  if (!getUserId() || isMerchant()) return Promise.resolve();
  if (!shoppingLoad) shoppingLoad = shoppingLoadCatalog().finally(() => { shoppingLoad = null; });
  return shoppingLoad;
}

// Connects first when needed (mic, send). Throws the load's real error.
async function shoppingEnsureConnected() {
  if (pharmacyApi.mode) return;
  await initShopping();
  if (!pharmacyApi.mode) throw shop.loadError || new Error('The pharmacy is not connected yet. Please try again.');
}

function shoppingScheduleRetry() {
  clearTimeout(shoppingRetryTimer);
  shoppingRetryTimer = setTimeout(() => { if (!pharmacyApi.mode) initShopping(); }, shoppingRetryDelay);
  shoppingRetryDelay = Math.min(shoppingRetryDelay * 2, SHOPPING_RETRY_MAX_MS);
}

// A new location changes which pharmacy each medicine comes from (and its
// price): load the shelf again, measured from the new place.
let shoppingLocationKey = null;
locationSubscribe(state => {
  const place = state?.place || null;
  const key = place ? `${place.lat},${place.lng},${place.address || ''}` : '';
  if (key === shoppingLocationKey) return;
  const first = shoppingLocationKey === null;
  shoppingLocationKey = key;
  if (first || !pharmacyApi.mode || !getUserId()) return;
  console.info('siru: location changed - reloading nearest pharmacies', {source: place?.source || null});
  shoppingLoadCatalog();
});

async function shoppingLoadCatalog() {
  const generation = shop.generation;
  shop.connecting = true;
  shoppingControls();
  try {
    const products = await pharmacyApi.catalog();
    clearTimeout(shoppingRetryTimer);
    shoppingRetryDelay = SHOPPING_RETRY_MIN_MS;
    shop.loadError = null;
    // The shelf is the same for every user: show it even if the user changed during the load.
    shop.products = products;
    document.getElementById('productCount').textContent = `${shop.products.length} products`;
    shoppingRenderProducts();
    if (generation !== shop.generation) return;
    if (shop.currentUser !== getUserId()) await shoppingResetUser();
    else {
      // Retrying a failed load must not erase the conversation.
      await pharmacyApi.select(shop.selected, shop.quantity);
      shop.selectionError = null;
      await shoppingRefresh();
    }
  } catch (err) {
    if (pharmacyApi.mode) return;  // connected; a later step (cart refresh) reports its own error
    shop.loadError = err;
    shoppingScheduleRetry();
    shopEl.medicineList.textContent = `Couldn't load medicines. ${pharmacyError(err)} Retrying automatically…`;
    const retry = el_('button', '', 'Retry now');
    retry.type = 'button';
    retry.onclick = initShopping;
    shopEl.medicineList.append(retry);
    shopEl.cartStatus.textContent = 'Waiting for the pharmacy connection.';
    if (shop.lastLoadError !== err.message) shoppingNotice(`I couldn't connect to the pharmacy. ${pharmacyError(err)} I'll keep trying.`);
    shop.lastLoadError = err.message;
  } finally {
    shop.connecting = false;
    shoppingControls();
  }
}
const apiBaseInput = document.getElementById('apiBaseInput');
apiBaseInput.value = API_BASE;
// A deployed site's backend comes from config.js; a saved address would be
// ignored there, so the development-only setting isn't offered.
if (CONFIGURED_API_BASE) apiBaseInput.closest('.login-server').hidden = true;
document.getElementById('connectPharmacyBtn').onclick = () => {
  try {
    const base = new URL(apiBaseInput.value);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Enter an HTTP or HTTPS API address.');
    const normalized = base.href.replace(/\/+$/, '');
    if (normalized !== API_BASE) {
      for (const storage of [localStorage, sessionStorage]) {
        try { storage.setItem('pharmacy_api_base', normalized); } catch {}
      }
      location.reload();
    } else initShopping();
  } catch (err) { shoppingMessage(err.message); }
};
// Keeps other tabs' cart changes visible.
setInterval(() => { if (!document.hidden && shop.products.length) shoppingRefresh(); }, 2500);
window.addEventListener("focus", () => { if (pharmacyApi.mode) shoppingRefresh(); else initShopping(); });
window.addEventListener("online", () => { if (!pharmacyApi.mode) initShopping(); });
