// Sign-in screen and the signed-in user's menu (users.js holds the session).
const loginEl = Object.fromEntries([
  'loginView', 'appView', 'loginForm', 'loginEmail', 'loginPassword', 'loginError', 'loginBtn',
  'userMenu', 'currentUserAvatar', 'currentUserName', 'currentUserLanguage', 'currentUserEmail',
  'languageSelect', 'logoutBtn', 'merchantView', 'brandSub',
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
