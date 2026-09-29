// Sign-in screen and the signed-in user's menu (users.js holds the session).
const loginEl = Object.fromEntries([
  'loginView', 'appView', 'loginForm', 'loginEmail', 'loginPassword', 'loginError', 'loginBtn',
  'userMenu', 'currentUserAvatar', 'currentUserName', 'currentUserLanguage', 'currentUserEmail',
  'languageSelect', 'logoutBtn', 'merchantView', 'brandSub',
  'demoMerchants', 'demoMerchantsNote', 'demoMerchantSelect', 'demoMerchantBtn', 'demoMerchantError',
].map(id => [id, document.getElementById(id)]));
let authExpiryTimer = null;

// A merchant (role from the server, users.js currentRole) gets the merchant
// page (merchant.js) and none of the pharmacy page: no cart, orders, nearby
// pharmacies, voice or notifications. Everyone else gets the pharmacy page.
function renderCurrentUser() {
  const user = currentProfile();
  const merchantUser = Boolean(user) && isMerchant();
  loginEl.loginView.hidden = Boolean(user);
  loginEl.appView.hidden = !user || merchantUser;
  loginEl.merchantView.hidden = !merchantUser;
  loginEl.userMenu.hidden = !user;
  el.notifBell.hidden = !user || merchantUser;
  document.getElementById('ordersBtn').hidden = !user || merchantUser;
  // Location | Nearby | Cart | Orders in the top bar: buyers only.
  document.getElementById('contextRow').hidden = !user || merchantUser;
  if (!user || merchantUser) {
    for (const id of ['ordersDialog', 'shopDialog', 'orderDialog', 'cartDialog']) document.getElementById(id).close();
    el.notifPanel.hidden = true;
  }
  loginEl.currentUserName.textContent = user?.name || '';
  loginEl.currentUserAvatar.textContent = user?.avatar || '';
  loginEl.currentUserLanguage.textContent = !user ? '' : merchantUser ? 'Merchant account' : `Replies in ${user.language}`;
  loginEl.currentUserEmail.textContent = user?.email || '';
  loginEl.languageSelect.value = user?.language_code || 'en-IN';
  loginEl.languageSelect.closest('label').hidden = merchantUser;
  loginEl.brandSub.textContent = merchantUser ? 'Merchant assistant' : 'AI pharmacy assistant';
  document.title = merchantUser ? 'Siru Merchant — Store dashboard' : 'Siru Pharmacy — AI Assistant';
  el.micBtn.disabled = !user || merchantUser;
}

function showLoginError(message) {
  loginEl.loginError.textContent = message;
  loginEl.loginError.hidden = !message;
}

// Everything on the page belongs to one user: clear it before showing another.
async function applySignedInUser() {
  clearTimeout(authExpiryTimer);
  if (authSession) authExpiryTimer = setTimeout(authExpired, Math.max(0, authSession.expires_at * 1000 - Date.now()));
  loginEl.userMenu.open = false;
  el.askInput.value = '';
  el.notifList.replaceChildren();
  el.toastContainer.replaceChildren();
  el.notifPanel.hidden = true;
  knownNotifiedIds = null;
  setNotifCount(0);
  renderCurrentUser();
  merchantApplyUser();
  // A merchant never starts the pharmacy page (cart, location, voice...).
  if (isMerchant()) return;
  await shoppingResetUser();
  if (getUserId()) { refreshNotifications(); locationStart(getUserId()); }
}

async function signOut(message = '') {
  await stopVoiceSession();
  // The chat of the session being left is kept, just no longer shown; memory,
  // cart and orders live on the server and are not touched. The next sign-in
  // starts a new, empty session (userStartSession below).
  userEndSession(getUserId());
  // Where the user was is not kept past their sign-in.
  locationEnd(getUserId());
  // The token is revoked on the server too (POST /v1/auth/logout), so a copy
  // of it left anywhere stops working now - not only when it expires.
  const token = authToken();
  if (token && !message) {
    fetch(`${API_BASE}/v1/auth/logout`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}}).catch(() => {});
  }
  authSave(null);
  loginEl.loginPassword.value = '';
  showLoginError(message);
  await applySignedInUser();
  loginEl.loginEmail.focus();
}

// A reload keeps the role the server gave at sign-in: ask the server again,
// so the page shown always matches the role it enforces.
async function authConfirmRole() {
  const session = authSession;
  if (!session) return;
  try {
    const me = await apiFetch('/v1/auth/me');
    const role = me?.role === 'merchant' ? 'merchant' : 'buyer';
    if (authSession === session && (session.user.role || 'buyer') !== role) authSave({...session, user: {...session.user, role}});
  } catch {}  // unreachable: keep the stored role (a 401 has already signed out)
}

// A 401 on any call (apiFetch) or the token's expiry time.
function authExpired() {
  if (authSession) signOut('Your session has expired. Please sign in again.');
}

loginEl.loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const email = loginEl.loginEmail.value.trim();
  const password = loginEl.loginPassword.value;
  if (!email || !password) { showLoginError('Enter your email and password.'); return; }
  showLoginError('');
  loginEl.loginBtn.disabled = true;
  loginEl.loginBtn.textContent = 'Signing in…';
  try {
    const res = await fetch(`${API_BASE}/v1/auth/login`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showLoginError(typeof data.detail === 'string' ? data.detail : `Sign-in failed (${res.status}).`);
      return;
    }
    loginEl.loginPassword.value = '';
    authSave(data);
    // A fresh chat for every sign-in. The session itself is created when the
    // user first types or speaks (users.js userEnsureSession), so signing in
    // and looking around doesn't leave an empty session behind.
    await applySignedInUser();
  } catch (err) {
    showLoginError(`Cannot reach the pharmacy API at ${API_BASE}. Check the server address below.`);
  } finally {
    loginEl.loginBtn.disabled = false;
    loginEl.loginBtn.textContent = 'Sign in';
  }
});

// Local development only: sign in as one of the merchants the client
// database really has (GET /v1/auth/demo-merchants - the API reads them from
// the client database, read-only; 404 anywhere but development, and this
// block then stays hidden). The store shown is what the database returned;
// the dashboard is scoped by the signed-in merchant, never by this choice.
async function loadDemoMerchants() {
  const box = loginEl.demoMerchants;
  if (!box) return;
  let res;
  try {
    res = await fetch(`${API_BASE}/v1/auth/demo-merchants`);
  } catch {
    return;  // the API isn't reachable - the sign-in form says so when used
  }
  if (res.status === 404) return;  // not a development server
  const data = await res.json().catch(() => ({}));
  box.hidden = false;
  const select = loginEl.demoMerchantSelect;
  select.replaceChildren();
  if (!res.ok) {
    loginEl.demoMerchantsNote.textContent = data?.detail?.message || `Merchant data is unavailable (${res.status}).`;
    select.disabled = loginEl.demoMerchantBtn.disabled = true;
    return;
  }
  const merchants = Array.isArray(data.merchants) ? data.merchants : [];
  const source = data.source === 'client_rds' ? 'the client database' : `the ${data.source || 'configured'} data`;
  if (!merchants.length) {
    loginEl.demoMerchantsNote.textContent = `No merchant data available: ${source} has no store with an owner.`;
    select.disabled = loginEl.demoMerchantBtn.disabled = true;
    return;
  }
  loginEl.demoMerchantsNote.textContent = `${merchants.length} merchant${merchants.length === 1 ? '' : 's'} from ${source} (read-only).`;
  for (const merchant of merchants) {
    const stores = merchant.stores || [];
    const first = stores[0] || {};
    const option = document.createElement('option');
    option.value = merchant.merchantId;
    option.textContent = stores.length > 1
      ? `${first.name} + ${stores.length - 1} more store${stores.length > 2 ? 's' : ''}`
      : `${first.name} · ${first.isOpen ? 'open' : 'closed'} · ${first.catalogItems} items · ${first.orders} orders`;
    select.append(option);
  }
  select.disabled = loginEl.demoMerchantBtn.disabled = false;
}

loginEl.demoMerchantBtn?.addEventListener('click', async () => {
  const merchantId = loginEl.demoMerchantSelect.value;
  if (!merchantId) return;
  loginEl.demoMerchantError.hidden = true;
  loginEl.demoMerchantBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/v1/auth/demo-merchants/login`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({merchant_id: merchantId}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : data?.detail?.message;
      loginEl.demoMerchantError.textContent = detail || `Sign-in failed (${res.status}).`;
      loginEl.demoMerchantError.hidden = false;
      return;
    }
    authSave(data);
    await applySignedInUser();
  } catch {
    loginEl.demoMerchantError.textContent = `Cannot reach the pharmacy API at ${API_BASE}.`;
    loginEl.demoMerchantError.hidden = false;
  } finally {
    loginEl.demoMerchantBtn.disabled = false;
  }
});

for (const language of ASSISTANT_LANGUAGES) {
  const option = document.createElement('option');
  option.value = language.code;
  option.textContent = language.label;
  loginEl.languageSelect.append(option);
}
loginEl.languageSelect.addEventListener('change', async () => {
  if (!getUserId()) return;
  userWrite(`siru_language_${getUserId()}`, loginEl.languageSelect.value);
  renderCurrentUser();
  // The voice session was started in the old language: the next tap uses the new one.
  if (voiceRoom) {
    await stopVoiceSession();
    setVoiceStatus('Language changed. Tap the mic to talk again.');
  }
});
loginEl.logoutBtn.onclick = () => signOut();

renderCurrentUser();
if (getUserId()) authConfirmRole().then(() => { if (getUserId()) applySignedInUser(); });
else loginEl.loginEmail.focus();
loadDemoMerchants();
