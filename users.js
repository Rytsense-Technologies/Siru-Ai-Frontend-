// The signed-in user. POST /v1/auth/login returns a login token; every API
// call sends it (app.js apiHeaders) and the backend takes the user from it -
// chat, cart, orders and the voice room all belong to that user. The token is
// kept for this tab only (sessionStorage) and dropped when it expires.
const SESSION_KEY = 'siru_session';
const ASSISTANT_LANGUAGES = [
  {code:'en-IN', label:'English'},
  {code:'ta-IN', label:'Tamil'},
  {code:'hi-IN', label:'Hindi'},
  {code:'te-IN', label:'Telugu'},
];
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
function userLanguage(id) {
  const code = userRead(`siru_language_${id}`, 'en-IN');
  return ASSISTANT_LANGUAGES.find(l => l.code === code) || ASSISTANT_LANGUAGES[0];
}
function currentProfile() {
  if (!authSession) return null;
  const {id, name, email} = authSession.user;
  const language = userLanguage(id);
  return {id, name: name || email, email, role: currentRole(), language: language.label, language_code: language.code,
    avatar: initials(name || email)};
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
