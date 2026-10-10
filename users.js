// The signed-in user. POST /v1/auth/login returns a login token; every API
// call sends it (app.js apiHeaders) and the backend takes the user from it -
// chat, cart, orders and the voice room all belong to that user. The token is
// kept for this tab only (sessionStorage) and dropped when it expires.
const SESSION_KEY = 'siru_session';
const userMemory = new Map();
function userRead(key, fallback = null, storage = localStorage) {
  try { return JSON.parse(storage.getItem(key)) ?? userMemory.get(key) ?? fallback; }
  catch { return userMemory.get(key) ?? fallback; }
}
function userWrite(key, value, storage = localStorage) {
  userMemory.set(key, value);
  try { storage.setItem(key, JSON.stringify(value)); } catch {}
}
function userForget(key, storage = localStorage) {
  userMemory.delete(key);
  try { storage.removeItem(key); } catch {}
}

// What this device keeps for the people who sign in on it - their
// conversations, the inspector's activity (tool calls, health information),
// their location, the chat session pointer. Removed when someone signs out
// and when someone new signs in, so the next person on this device never
// sees it. App settings (the API address) belong to no user and stay.
const USER_DATA_PREFIXES = ['siru_chat_', 'siru_sessions_', 'siru_activity_', 'siru_location_', 'siru_current_session_'];
function userDataKey(key) { return USER_DATA_PREFIXES.some(prefix => key.startsWith(prefix)); }
// How many times this device has been wiped. A reply or booking that started
// before a wipe (its user signed out, or someone new signed in) must not write
// that user's conversation back (shopping.js shoppingSubmit, shoppingPrepareBooking).
let deviceWipes = 0;
function deviceWipeCount() { return deviceWipes; }
function userForgetDevice() {
  deviceWipes++;
  for (const storage of [localStorage, sessionStorage]) {
    try {
      for (const key of Object.keys(storage)) if (userDataKey(key)) storage.removeItem(key);
    } catch {}
  }
  for (const key of [...userMemory.keys()]) if (userDataKey(key)) userMemory.delete(key);
}

// Bug #12B: whether `key` is this user's own. Chats and activity are `<prefix><id>_<session>`
// (a session id has no "_"); the others are exactly `<prefix><id>` - so user "a" never owns
// "ab"'s or "a_b"'s keys.
const USER_SESSION_PREFIXES = ['siru_chat_', 'siru_activity_'];
function userOwnsKey(key, userId) {
  return USER_DATA_PREFIXES.some(prefix => {
    const own = prefix + userId;
    if (!USER_SESSION_PREFIXES.includes(prefix)) return key === own;
    return key.startsWith(own + '_') && !key.slice(own.length + 1).includes('_');
  });
}

// A sign-in: everything another person left on this device goes (as userForgetDevice),
// but never the signing-in user's own chats and activity - another tab of theirs, or
// their previous sign-in here, keeps its history (Bug #12B). No id: everyone's goes.
function userForgetOthers(userId) {
  if (!userId) return userForgetDevice();
  const other = key => userDataKey(key) && !userOwnsKey(key, userId);
  for (const storage of [localStorage, sessionStorage]) {
    try {
      for (const key of Object.keys(storage)) if (other(key)) storage.removeItem(key);
    } catch {}
  }
  for (const key of [...userMemory.keys()]) if (other(key)) userMemory.delete(key);
}

function sessionValid(session) {
  return Boolean(session?.access_token && session?.user?.id && session.expires_at * 1000 > Date.now());
}
let authSession = userRead(SESSION_KEY, null, sessionStorage);
if (!sessionValid(authSession)) authSession = null;
let currentUserId = authSession?.user.id || null;

function authToken() { return authSession?.access_token || ''; }

// The signed-in user's role: what the server said at sign-in, confirmed on
// every page load by GET /v1/auth/me (user-menu.js authConfirmRole). It only
// picks which page to show - the server enforces the role on every call.
function currentRole() { return authSession?.user?.role === 'merchant' ? 'merchant' : 'buyer'; }
function isMerchant() { return Boolean(authSession) && currentRole() === 'merchant'; }
function authSave(session) {
  authSession = session;
  currentUserId = session?.user.id || null;
  if (session) userWrite(SESSION_KEY, session, sessionStorage);
  else userForget(SESSION_KEY, sessionStorage);
}

function initials(name) {
  return String(name || '?').split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}
// No assistant language is chosen or kept: the backend answers each message
// in the language it is written or spoken in. A choice saved by an older page
// (siru_language_<user>) is dropped.
try {
  for (const key of Object.keys(localStorage)) if (key.startsWith('siru_language_')) localStorage.removeItem(key);
} catch {}
function currentProfile() {
  if (!authSession) return null;
  const {id, name, email} = authSession.user;
  return {id, name: name || email, email, role: currentRole(), avatar: initials(name || email)};
}

// Chat is per user AND per session. Signing in starts a new session, so the
// chat on screen always starts empty; earlier sessions are kept on this
// device (siru_chat_<user>_<session>, listed in siru_sessions_<user>) and
// simply not shown. Memory, cart and orders are per user and untouched by
// this - they live on the server and outlive every session.
const SESSION_HISTORY_LIMIT = 50;

function chatKey(id, sessionId) { return `siru_chat_${id}_${sessionId}`; }
function currentSessionKey(id) { return `siru_current_session_${id}`; }

// Every session this user has had on this device, oldest first.
function userSessions(id) { return id ? userRead(`siru_sessions_${id}`, []) : []; }

// A new, empty chat session. Created when the user actually starts talking
// or typing - signing in alone doesn't make one.
function userStartSession(id) {
  if (!id) return null;
  const session = {id: crypto.randomUUID(), started_at: new Date().toISOString()};
  userWrite(`siru_sessions_${id}`, [...userSessions(id), session].slice(-SESSION_HISTORY_LIMIT));
  userWrite(currentSessionKey(id), session.id, sessionStorage);
  return session.id;
}

// The session this tab is in, or null before the user has said anything.
// A reload keeps it (the chat on screen survives); a new sign-in has none
// until the first message. Kept per tab, like the login itself.
function userSession(id) {
  return id ? userRead(currentSessionKey(id), null, sessionStorage) : null;
}

// The session to write into: starts one on the first message of a sign-in.
function userEnsureSession(id) {
  if (!id) return null;
  return userSession(id) || userStartSession(id);
}

// Signing out ends the session without deleting its chat: the next sign-in
// starts a new one.
function userEndSession(id) {
  if (id) userForget(currentSessionKey(id), sessionStorage);
}

// The messages of the session on screen - empty in a new one.
function userHistory(id) {
  const sessionId = userSession(id);
  return sessionId ? userRead(chatKey(id, sessionId), []) : [];
}

function userSaveMessage(id, message) {
  // Saving a message means the conversation has started: it gets the session.
  const sessionId = userEnsureSession(id);
  if (!id || !sessionId) return;
  const messages = userHistory(id);
  const index = messages.findIndex(item => item.id === message.id);
  if (index < 0) messages.push(message); else messages[index] = message;
  userWrite(chatKey(id, sessionId), messages);
}
