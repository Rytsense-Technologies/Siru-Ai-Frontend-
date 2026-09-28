// Merchant accounts (role "merchant" - from sign-in, confirmed by
// GET /v1/auth/me in user-menu.js): the store's dashboard and the merchant
// assistant, instead of the buyer pharmacy page.
//
//   figures:   GET /v1/merchant/{section} - one of the merchant agent's own
//              read-only tools, called directly (api/routes/merchant.py)
//   assistant: POST /v1/agents/run - the merchant agent and its 8 tools
//
// Every figure shown is what provider-service returned for this merchant's
// store. When it can't answer (not configured, unreachable), the page says so
// - it never shows a made-up number. Money from the tools is in paise.

const MERCHANT_VIEWS = [
  {id: 'overview', label: 'Dashboard', icon: 'activity', title: 'Dashboard'},
  {id: 'earnings', label: 'Earnings', icon: 'bag', title: 'Earnings', section: 'earnings'},
  {id: 'orders', label: 'Orders', icon: 'package', title: 'Orders', section: 'orders'},
  {id: 'top-items', label: 'Top items', icon: 'store', title: 'Top items', section: 'top-items'},
  {id: 'low-stock', label: 'Low stock', icon: 'alert', title: 'Low stock', section: 'low-stock'},
  {id: 'catalog', label: 'Catalog', icon: 'database', title: 'Catalog', section: 'catalog'},
  {id: 'assistant', label: 'AI Assistant', icon: 'send', title: 'AI Assistant'},
];
const MERCHANT_SUGGESTIONS = [
  'How is my store doing today?', 'What did I earn this week?', 'Show my new orders',
  'Which items are low on stock?', 'What are my best sellers this month?',
];

const merchantEl = Object.fromEntries([
  'merchantView', 'merchantNav', 'merchantName', 'merchantIdLine', 'merchantEyebrow', 'merchantTitle',
  'merchantSub', 'merchantRefresh', 'merchantNotice', 'merchantBody', 'merchantAssistant', 'merchantLog',
  'merchantSuggestions', 'merchantForm', 'merchantInput', 'merchantSend', 'merchantChatStatus',
].map(id => [id, document.getElementById(id)]));

const merchant = {
  view: 'overview',
  user: null,
  storeName: null,      // the store's own name, from the dashboard figures
  generation: 0,        // bumped on sign-in / sign-out: late replies are dropped
  sections: new Map(),  // section key -> Promise<{data} | {error}>
  topWindow: 'week',
  history: [],          // [{role, content}] - this sign-in's assistant turns
  conversationId: null,
  busy: false,
};

// ---------- formatting ----------

const merchantRupees = new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR', maximumFractionDigits: 2});
const merchantCount = new Intl.NumberFormat('en-IN');

// Keys whose numbers are money (the tools send paise): "...Paise" always;
// revenue / payout / total ... unless the key says it counts something.
const MONEY_KEY = /revenue|gross|net|payout|settled|pending|amount|sales|earning|price|total/i;
const COUNT_KEY = /count|qty|quantity|units|orders|items|stock/i;

// `counted`: the value sits under a key that counts something ("orders":
// {"total": 46} is 46 orders, not ₹0.46) - only a "...Paise" key is money there.
function merchantIsMoney(key, counted = false) {
  return /paise/i.test(key) || (!counted && MONEY_KEY.test(key) && !COUNT_KEY.test(key));
}

function merchantValue(key, value, counted = false) {
  if (typeof value === 'number') return merchantIsMoney(key, counted) ? merchantRupees.format(value / 100) : merchantCount.format(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString('en-IN', {dateStyle: 'medium', timeStyle: 'short'});
  }
  return String(value);
}

function merchantLabel(key) {
  const words = String(key).replace(/Paise$/i, '').replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : String(key);
}

// Every scalar in an object, to two levels: [{key, label, value}].
function merchantScalars(data, prefix = '', depth = 0, counted = false) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const rows = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') {
      if (!Array.isArray(value) && depth < 2) {
        rows.push(...merchantScalars(value, `${prefix}${merchantLabel(key)} · `, depth + 1, counted || COUNT_KEY.test(key)));
      }
      continue;
    }
    rows.push({key, label: `${prefix}${merchantLabel(key)}`, value: merchantValue(key, value, counted), raw: value});
  }
  return rows;
}

// The list in a tool result: the result itself, or its first array field.
function merchantList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['items', 'data', 'orders', 'results', 'rows', 'list', 'recentOrders']) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === 'object' && Array.isArray(data[key].items)) return data[key].items;
  }
  return Object.values(data).find(Array.isArray) || [];
}

function merchantPick(row, keys) {
  for (const key of keys) if (row?.[key] !== undefined && row[key] !== null && row[key] !== '') return [key, row[key]];
  return [null, null];
}

// ---------- small DOM helpers ----------

function mEl(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function mBadge(text) {
  const tone = /out|cancel|fail|expired|critical/i.test(text) ? 'danger'
    : /low|pending|new|expiring|packing|delay/i.test(text) ? 'warning'
      : /done|deliver|ready|complete|settled|paid|in.?stock/i.test(text) ? 'success' : 'neutral';
  return mEl('span', `m-badge m-badge-${tone}`, merchantLabel(text));
}

function mPanel(title, {wide = false, action = null} = {}) {
  const panel = mEl('section', `card m-panel${wide ? ' m-panel-wide' : ''}`);
  const head = mEl('div', 'panel-head');
  head.append(mEl('h2', '', title));
  if (action) head.append(action);
  panel.append(head);
  return panel;
}

function mState(text, tone = 'muted') {
  const p = mEl('p', `m-state m-state-${tone}`, text);
  p.setAttribute('role', 'status');
  return p;
}

// ---------- data ----------

function merchantFetch(section, query = '') {
  const key = `${section}${query}`;
  if (!merchant.sections.has(key)) {
    const generation = merchant.generation;
    merchant.sections.set(key, apiFetch(`/v1/merchant/${section}${query}`)
      .then(body => ({data: body.data}))
      .catch(err => {
        if (generation === merchant.generation) merchant.sections.delete(key);  // a retry asks again
        return {error: err};
      }));
  }
  return merchant.sections.get(key);
}

const NOT_CONNECTED = 'provider_not_configured';

function merchantNotConnected(err) { return err?.detail?.code === NOT_CONNECTED; }

// A panel's own line: short when the whole page already says why (merchantNotice).
function merchantPanelError(err) {
  return merchantNotConnected(err) ? 'Not available - provider-service is not connected.' : merchantErrorText(err);
}

function merchantErrorText(err) {
  if (err?.detail?.message) return err.detail.message;
  if (err?.status === 403) return 'This page is only for merchant accounts.';
  if (err?.status) return `The store data request failed (${err.status}).`;
  return `Cannot reach the API at ${API_BASE}.`;
}

// ---------- renderers ----------

function mKeyValues(rows) {
  const list = mEl('dl', 'm-kv');
  for (const row of rows) list.append(mEl('dt', '', row.label), mEl('dd', '', row.value));
  return list;
}

function mRows(items, {limit = 0, empty}) {
  if (!items.length) return mState(empty);
  const list = mEl('ul', 'm-rows');
  for (const item of limit ? items.slice(0, limit) : items) {
    const li = mEl('li', 'm-row');
    if (item === null || typeof item !== 'object') {
      li.append(mEl('strong', '', String(item)));
      list.append(li);
      continue;
    }
    const [, title] = merchantPick(item, ['name', 'itemName', 'productName', 'title', 'number', 'orderNumber', 'orderNo', 'displayId', 'code', 'id']);
    const [, sub] = merchantPick(item, ['category', 'brand', 'sku', 'at', 'createdAt', 'placedAt', 'expiryDate']);
    const [metaKey, meta] = merchantPick(item, ['unitsSold', 'units', 'qty', 'quantity', 'stock', 'stockQty', 'available', 'itemCount', 'count']);
    const [moneyKey, money] = merchantPick(item, ['totalPaise', 'amountPaise', 'revenuePaise', 'grossPaise', 'pricePaise', 'total', 'amount']);
    const [, status] = merchantPick(item, ['status', 'stockStatus', 'state']);
    const text = mEl('div', 'm-row-text');
    text.append(mEl('strong', '', title !== null ? String(title) : 'Item'));
    if (sub !== null) text.append(mEl('span', 'muted small', merchantValue('sub', sub)));
    const side = mEl('div', 'm-row-side');
    if (money !== null) side.append(mEl('span', 'm-money', merchantValue(moneyKey, money)));
    if (meta !== null) side.append(mEl('span', 'muted small', `${merchantLabel(metaKey)}: ${merchantValue(metaKey, meta)}`));
    if (status !== null) side.append(mBadge(String(status)));
    li.append(text, side);
    list.append(li);
  }
  return list;
}

function mTiles(tiles) {
  const grid = mEl('div', 'm-tiles');
  for (const tile of tiles) {
    const card = mEl('div', `card m-tile${tile.tone ? ` m-tile-${tile.tone}` : ''}`);
    card.append(mEl('span', 'm-tile-label', tile.label), mEl('strong', 'm-tile-value', tile.value));
    if (tile.note) card.append(mEl('span', 'muted small', tile.note));
    grid.append(card);
  }
  return grid;
}

// A section's panel body: loading, then its figures or an honest error.
async function mFill(panel, section, render, query = '') {
  const body = mEl('div', 'm-panel-body');
  body.append(mState('Loading…'));
  panel.append(body);
  const generation = merchant.generation;
  const result = await merchantFetch(section, query);
  if (generation !== merchant.generation) return result;
  body.replaceChildren(result.error ? mState(merchantPanelError(result.error), 'error') : render(result.data));
  return result;
}

const MERCHANT_EMPTY = {
  orders: 'No orders yet.',
  'top-items': 'No items sold in this period yet.',
  'low-stock': 'Nothing is low, out of stock or expiring.',
};
// The limits api/routes/merchant.py asks for: a full list may have more.
const MERCHANT_LIMITS = {orders: 10, 'top-items': 5, 'low-stock': 15};

const merchantRender = {
  dashboard: data => {
    // The store's name is in the page heading (merchantStoreName).
    const {store, ...figures} = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const rows = merchantScalars(figures);
    if (store && typeof store.isOpen === 'boolean') rows.unshift({label: 'Store', value: store.isOpen ? 'Open' : 'Closed'});
    const recent = merchantList(figures);
    const wrap = mEl('div');
    wrap.append(rows.length ? mKeyValues(rows) : mState('No summary figures for today yet.'));
    if (recent.length) wrap.append(mEl('h3', 'm-subhead', 'Recent'), mRows(recent, {limit: 5, empty: ''}));
    return wrap;
  },
  earnings: data => {
    const periods = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']].filter(([key]) => data?.[key]);
    if (!periods.length) {
      const rows = merchantScalars(data);
      return rows.length ? mKeyValues(rows) : mState('No earnings data available.');
    }
    // Today / this week / this month side by side, one row per figure.
    const keys = [...new Set(periods.flatMap(([key]) => Object.keys(data[key] || {})))];
    const table = mEl('table', 'm-table');
    const head = mEl('tr');
    head.append(mEl('th', '', ''), ...periods.map(([, label]) => mEl('th', '', label)));
    table.append(head);
    for (const key of keys) {
      const row = mEl('tr');
      row.append(mEl('th', '', merchantLabel(key)), ...periods.map(([period]) => {
        const value = data[period]?.[key];
        return mEl('td', '', value === undefined || value === null ? '-' : merchantValue(key, value));
      }));
      table.append(row);
    }
    const wrap = mEl('div');
    wrap.append(table);
    const rest = merchantScalars(Object.fromEntries(Object.entries(data).filter(([key]) => !periods.some(([p]) => p === key))));
    if (rest.length) wrap.append(mEl('h3', 'm-subhead', 'Settlements'), mKeyValues(rest));
    wrap.append(mEl('p', 'muted small', 'Counted from delivered and completed orders.'));
    return wrap;
  },
  orders: data => mRows(merchantList(data), {empty: MERCHANT_EMPTY.orders}),
  'top-items': data => mRows(merchantList(data), {empty: MERCHANT_EMPTY['top-items']}),
  'low-stock': data => mRows(merchantList(data), {empty: MERCHANT_EMPTY['low-stock']}),
  catalog: data => mTiles([
    {label: 'Items in catalog', value: merchantCount.format(Number(data?.totalItems ?? 0))},
    {label: 'Out of stock', value: merchantCount.format(Number(data?.outOfStockItems ?? 0)),
      tone: Number(data?.outOfStockItems) > 0 ? 'danger' : ''},
  ]),
};

// ---------- views ----------

async function merchantOverview() {
  const body = merchantEl.merchantBody;
  const tiles = mEl('div', 'm-tiles-slot');
  tiles.append(mState('Loading your store…'));
  const grid = mEl('div', 'm-grid');
  body.replaceChildren(tiles, grid);
  const panels = [
    ['Today', 'dashboard'], ['Earnings', 'earnings'], ['Recent orders', 'orders'],
    ['Top items this week', 'top-items'], ['Stock alerts', 'low-stock'],
  ];
  const results = await Promise.all(panels.map(([title, section]) => {
    const panel = mPanel(title, {action: merchantOpenLink(section)});
    grid.append(panel);
    const render = MERCHANT_EMPTY[section]
      ? data => mRows(merchantList(data), {limit: 5, empty: MERCHANT_EMPTY[section]})
      : merchantRender[section];
    return mFill(panel, section, render);
  }));
  merchantStoreName(results[0]?.data?.store?.name);
  const catalog = await merchantFetch('catalog');
  if (!merchantEl.merchantBody.contains(tiles)) return;  // left the page meanwhile
  const failed = [...results, catalog].filter(r => r?.error);
  const notConnected = failed.find(r => merchantNotConnected(r.error));
  merchantNotice(notConnected ? `${merchantErrorText(notConnected.error)} Nothing on this page is estimated.` : '');
  if (failed.length === results.length + 1) {
    tiles.replaceChildren();
    return;
  }
  const summary = [];
  if (!catalog.error) {
    summary.push({label: 'Catalog items', value: merchantCount.format(Number(catalog.data?.totalItems ?? 0))});
    summary.push({label: 'Out of stock', value: merchantCount.format(Number(catalog.data?.outOfStockItems ?? 0)),
      tone: Number(catalog.data?.outOfStockItems) > 0 ? 'danger' : ''});
  }
  const lowStock = results[4];
  if (!lowStock.error) {
    // The server's own count when it sends one; else the rows (at most the limit asked for).
    const total = Number(lowStock.data?.meta?.total);
    const alerts = Number.isFinite(total) ? total : merchantList(lowStock.data).length;
    const capped = !Number.isFinite(total) && alerts >= MERCHANT_LIMITS['low-stock'];
    summary.push({label: 'Stock alerts', tone: alerts ? 'warning' : '',
      value: capped ? `${alerts}+` : merchantCount.format(alerts)});
  }
  tiles.replaceChildren(summary.length ? mTiles(summary) : mEl('span'));
}

function merchantOpenLink(section) {
  const view = MERCHANT_VIEWS.find(v => v.section === section);
  if (!view || section === 'dashboard') return null;
  const link = mEl('button', 'link-btn', 'View all');
  link.type = 'button';
  link.onclick = () => merchantShow(view.id);
  return link;
}

async function merchantSectionView(view) {
  const body = merchantEl.merchantBody;
  let action = null;
  let query = '';
  if (view.section === 'top-items') {
    action = mEl('div', 'm-segment');
    action.setAttribute('role', 'group');
    action.setAttribute('aria-label', 'Period');
    for (const [value, label] of [['today', 'Today'], ['week', 'This week'], ['month', 'This month']]) {
      const button = mEl('button', 'm-segment-btn', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(merchant.topWindow === value));
      button.onclick = () => { merchant.topWindow = value; merchantShow('top-items'); };
      action.append(button);
    }
    query = `?window=${merchant.topWindow}`;
  }
  const panel = mPanel(view.title, {wide: true, action});
  body.replaceChildren(panel);
  if (view.section === 'catalog') {
    // The totals, then the store's own products.
    const products = mPanel('Products', {wide: true});
    body.append(products);
    mFill(products, 'catalog-items', data => {
      const items = merchantList(data);
      const wrap = mEl('div');
      const total = Number(data?.meta?.total ?? items.length);
      if (items.length) wrap.append(mEl('p', 'muted small', `Showing ${items.length} of ${merchantCount.format(total)} products`));
      wrap.append(mRows(items, {empty: 'No products in this catalog yet.'}));
      return wrap;
    }, '?limit=100');
  }
  const result = await mFill(panel, view.section, merchantRender[view.section], query);
  if (merchantEl.merchantBody.contains(panel)) merchantNotice(merchantNotConnected(result?.error)
    ? `${merchantErrorText(result.error)} Nothing on this page is estimated.` : '');
}

// The store's own name (the dashboard figures), once known: the heading and the sidebar.
function merchantStoreName(name) {
  if (typeof name !== 'string' || !name.trim() || !merchant.user) return;
  merchant.storeName = name.trim();
  merchantEl.merchantName.textContent = merchant.storeName;
  merchantEl.merchantIdLine.textContent = merchant.user.name;
  if (merchant.view === 'overview') merchantEl.merchantTitle.textContent = merchant.storeName;
}

function merchantNotice(text) {
  merchantEl.merchantNotice.textContent = text;
  merchantEl.merchantNotice.hidden = !text;
}

function merchantShow(id) {
  const view = MERCHANT_VIEWS.find(v => v.id === id) || MERCHANT_VIEWS[0];
  merchant.view = view.id;
  for (const button of merchantEl.merchantNav.querySelectorAll('[data-mview]')) {
    if (button.dataset.mview === view.id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  merchantEl.merchantEyebrow.textContent = view.id === 'overview' ? 'MERCHANT DASHBOARD' : 'MERCHANT';
  merchantEl.merchantTitle.textContent = view.id === 'overview'
    ? merchant.storeName || `Welcome, ${merchant.user?.name || 'merchant'}` : view.title;
  merchantEl.merchantSub.textContent = view.id === 'assistant'
    ? 'Ask about your own store - orders, earnings, best sellers and stock.'
    : "Figures come from your store's own records, read-only.";
  const assistant = view.id === 'assistant';
  merchantEl.merchantAssistant.hidden = !assistant;
  merchantEl.merchantBody.hidden = assistant;
  merchantEl.merchantRefresh.hidden = assistant;
  merchantNotice('');
  if (assistant) { merchantEl.merchantInput.focus(); return; }
  if (view.id === 'overview') merchantOverview(); else merchantSectionView(view);
}

// ---------- assistant ----------

function merchantCard(card) {
  // The store's figures sent without the model (bridge.merchant_fallback_turn):
  // drawn exactly as the dashboard page for that section draws them.
  if (card?.kind === 'merchant_section' && merchantRender[card.section]) {
    const box = mEl('div', 'm-card m-card-info');
    const view = MERCHANT_VIEWS.find(v => v.section === card.section);
    box.append(mEl('strong', 'm-card-title', view ? view.title : 'Store summary'));
    box.append(MERCHANT_EMPTY[card.section]
      ? mRows(merchantList(card.data), {limit: 8, empty: MERCHANT_EMPTY[card.section]})
      : merchantRender[card.section](card.data));
    return box;
  }
  if (card?.kind === 'choices') {
    const box = mEl('div', 'm-choices');
    if (card.question) box.append(mEl('p', 'm-choices-q', card.question));
    for (const option of card.options || []) {
      const button = mEl('button', 'ghost-btn', option.label);
      button.type = 'button';
      button.onclick = () => merchantAsk(option.value || option.label);
      box.append(button);
    }
    return box;
  }
  if (card?.kind !== 'ui') return null;
  const box = mEl('div', `m-card m-card-${['success', 'warning', 'danger', 'info'].includes(card.accent) ? card.accent : 'neutral'}`);
  if (card.title) box.append(mEl('strong', 'm-card-title', card.title));
  for (const block of Array.isArray(card.blocks) ? card.blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'header') { box.append(mEl('h4', '', block.text || '')); if (block.sub) box.append(mEl('p', 'muted small', block.sub)); }
    else if (block.type === 'paragraph') box.append(mEl('p', '', block.text || ''));
    else if (block.type === 'note') box.append(mEl('p', `m-note m-note-${block.tone || 'info'}`, block.text || ''));
    else if (block.type === 'divider') box.append(mEl('hr'));
    else if (block.type === 'keyvalue') {
      const list = mEl('dl', 'm-kv');
      for (const row of block.rows || []) {
        const dd = mEl('dd', row.strike ? 'm-strike' : '', String(row.value ?? ''));
        list.append(mEl('dt', '', String(row.label ?? '')), dd);
      }
      box.append(list);
    } else if (block.type === 'list') {
      const list = mEl('ul', 'm-rows');
      for (const item of block.items || []) {
        const li = mEl('li', 'm-row');
        const text = mEl('div', 'm-row-text');
        text.append(mEl('strong', '', String(item.title ?? '')));
        if (item.subtitle) text.append(mEl('span', 'muted small', String(item.subtitle)));
        const side = mEl('div', 'm-row-side');
        if (item.meta) side.append(mEl('span', 'm-money', String(item.meta)));
        if (item.badge?.text) side.append(mBadge(String(item.badge.text)));
        li.append(text, side);
        list.append(li);
      }
      box.append(list);
    } else if (block.type === 'status') {
      box.append(mEl('p', `m-note m-note-${block.state === 'failed' ? 'danger' : block.state === 'success' ? 'success' : 'info'}`,
        [block.label, block.detail].filter(Boolean).join(' - ')));
    }
  }
  return box;
}

function merchantBubble(role, text, cards = []) {
  const entry = mEl('div', `chat-entry ${role === 'user' ? 'user' : ''}`);
  if (text) entry.append(mEl('div', `chat-bubble ${role === 'user' ? 'user' : ''}`, text));
  for (const card of cards) { const node = merchantCard(card); if (node) entry.append(node); }
  merchantEl.merchantLog.append(entry);
  merchantEl.merchantLog.scrollTop = merchantEl.merchantLog.scrollHeight;
  merchantEl.merchantSuggestions.hidden = merchantEl.merchantLog.childElementCount > 0;
}

async function merchantAsk(text) {
  const question = String(text || '').trim();
  if (!question || merchant.busy) return;
  const generation = merchant.generation;
  merchant.busy = true;
  merchantEl.merchantSend.disabled = true;
  merchantEl.merchantChatStatus.textContent = 'Checking your store…';
  merchantEl.merchantChatStatus.classList.add('active');
  merchantBubble('user', question);
  merchantEl.merchantInput.value = '';
  try {
    const reply = await apiFetch('/v1/agents/run', {method: 'POST', body: JSON.stringify({
      user_input: question, history: merchant.history.slice(-20), conversation_id: merchant.conversationId,
    })});
    if (generation !== merchant.generation) return;
    const answer = typeof reply.final_output === 'string' ? reply.final_output : '';
    merchantBubble('assistant', answer, reply.cards || []);
    merchant.history.push({role: 'user', content: question});
    if (answer) merchant.history.push({role: 'assistant', content: answer});
  } catch (err) {
    if (generation !== merchant.generation) return;
    merchantBubble('assistant', `Sorry, I couldn't answer that. ${pharmacyError(err)}`);
  } finally {
    if (generation === merchant.generation) {
      merchant.busy = false;
      merchantEl.merchantSend.disabled = false;
      merchantEl.merchantChatStatus.textContent = 'Ready';
      merchantEl.merchantChatStatus.classList.remove('active');
    }
  }
}

// ---------- sign-in / sign-out (user-menu.js applySignedInUser) ----------

// Called for every sign-in state change: a merchant gets this page, anyone
// else gets it cleared (nothing of one merchant stays for the next user).
function merchantApplyUser() {
  merchant.generation++;
  merchant.sections.clear();
  merchant.history = [];
  merchant.busy = false;
  merchant.storeName = null;
  merchantEl.merchantLog.replaceChildren();
  merchantEl.merchantBody.replaceChildren();
  merchantEl.merchantSuggestions.hidden = false;
  merchantEl.merchantSend.disabled = false;
  merchantEl.merchantChatStatus.textContent = 'Ready';
  merchantNotice('');
  // Nothing of the last merchant stays on the page, shown or hidden.
  for (const node of [merchantEl.merchantName, merchantEl.merchantIdLine, merchantEl.merchantTitle, merchantEl.merchantSub]) {
    node.textContent = '';
  }
  merchantEl.merchantInput.value = '';
  const profile = currentProfile();
  merchant.user = profile && isMerchant() ? profile : null;
  if (!merchant.user) return;
  merchant.conversationId = `merchant-${crypto.randomUUID()}`;
  merchantEl.merchantName.textContent = merchant.user.name;
  merchantEl.merchantIdLine.textContent = merchant.user.email;
  merchantShow('overview');
}

for (const view of MERCHANT_VIEWS) {
  const button = mEl('button', 'm-nav-item');
  button.type = 'button';
  button.dataset.mview = view.id;
  const glyph = mEl('span', 'icon');
  glyph.dataset.icon = view.icon;
  button.append(glyph, mEl('span', '', view.label));
  button.onclick = () => merchantShow(view.id);
  merchantEl.merchantNav.append(button);
}
iconsHydrate(merchantEl.merchantNav);
for (const suggestion of MERCHANT_SUGGESTIONS) {
  const chip = mEl('button', 'm-chip', suggestion);
  chip.type = 'button';
  chip.onclick = () => merchantAsk(suggestion);
  merchantEl.merchantSuggestions.append(chip);
}
merchantEl.merchantForm.addEventListener('submit', event => { event.preventDefault(); merchantAsk(merchantEl.merchantInput.value); });
merchantEl.merchantRefresh.onclick = () => { merchant.sections.clear(); merchantShow(merchant.view); };
