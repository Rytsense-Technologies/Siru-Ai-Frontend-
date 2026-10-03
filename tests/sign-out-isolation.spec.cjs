// sec-2: signing out (or a new person signing in) leaves nothing of the
// previous user on this device (users.js userForgetDevice) - even when that
// user's reply or booking arrives after they left. The page's real sign-in
// form and signOut() run; only the network is stood in for: the sign-in, the
// concierge turn and the bookings API (held open until the test releases them).
const { test, expect } = require('@playwright/test');

const A = 'patient-a', B = 'patient-b';
const A_QUESTION = 'Patient A asks about heart medication';
const A_REPLY = 'Patient A reply about heart medication';

let held;  // responses held open, by name

test.beforeEach(async ({ page }) => {
  held = new Map();
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'};
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/auth/login') {
      const {email} = request.postDataJSON();
      return route.fulfill({headers: cors, json: {access_token: `token-${email}`, expires_at: Date.now() / 1000 + 3600,
        user: {id: email, role: 'buyer', name: email}}});
    }
    if (path === '/v1/actions/bookings') {
      const {doctor_code: code} = request.postDataJSON();
      await new Promise(release => held.set(`booking-${code}`, release));
      return route.fulfill({headers: cors, json: {card: {kind: 'confirm_action', actionId: `act-${code}`, title: `Book ${code}`,
        rows: [{label: 'Doctor', value: `Doctor for ${code}`}, {label: 'When', value: 'Mon 10:00'}]}}});
    }
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(({question}) => {
    // The concierge turn (pharmacy-api.js pharmacyApi.command), held open: the page's own submit code runs.
    window.heldTurn = null;
    pharmacyApi.command = () => new Promise(resolve => { heldTurn = resolve; });
    window.shoppingEnsureConnected = async () => {};
    window.shoppingSelectionReady = async () => {};
    // The real sign-in form: what a person on this device does.
    window.signIn = async email => {
      loginEl.loginEmail.value = email;
      loginEl.loginPassword.value = 'test-password';
      loginEl.loginForm.requestSubmit();
      for (let i = 0; i < 100 && getUserId() !== email; i++) await new Promise(r => setTimeout(r, 20));
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    };
    // Everything this device holds, and where anything of A's would show.
    window.device = () => [localStorage, sessionStorage].flatMap(storage => Object.keys(storage)
      .map(key => `${key}=${storage.getItem(key)}`)).join('\n');
    window.onScreen = () => shopEl.chatMessages.textContent;
    window.question = question;
  }, {question: A_QUESTION});
});

test("A's typed reply arriving after A signs out and B signs in leaves nothing of A on the device", async ({ page }) => {
  await page.evaluate(async () => {
    await signIn('patient-a');
    window.turnA = shoppingSubmit(question);
  });
  await expect.poll(() => page.evaluate(() => Boolean(heldTurn))).toBe(true);  // A's turn is in flight
  const atSignOut = await page.evaluate(async () => {
    await signOut();
    await signIn('patient-b');
    return device();
  });
  expect(atSignOut).not.toContain(A_QUESTION);  // the sign-out did wipe A
  const after = await page.evaluate(async reply => {
    heldTurn({message: reply, trace: {agent: 'care_agent', steps: []}, cards: []});
    await turnA;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {device: device(), screen: onScreen(), user: getUserId()};
  }, A_REPLY);
  expect(after.user).toBe(B);
  expect(after.screen).not.toContain(A_QUESTION);
  expect(after.screen).not.toContain(A_REPLY);
  // Nothing of A on this device while B uses it: not the question, not the reply, no chat or session of A.
  expect(after.device).not.toContain(A_QUESTION);
  expect(after.device).not.toContain(A_REPLY);
  expect(after.device).not.toMatch(/siru_(chat|sessions|current_session)_patient-a/);
});

test("A's typed reply arriving after A signs out, with nobody signed in, leaves nothing on the device", async ({ page }) => {
  await page.evaluate(async () => {
    await signIn('patient-a');
    window.turnA = shoppingSubmit(question);
  });
  await expect.poll(() => page.evaluate(() => Boolean(heldTurn))).toBe(true);
  const after = await page.evaluate(async reply => {
    await signOut();
    heldTurn({message: reply, trace: {agent: 'care_agent', steps: []}, cards: []});
    await turnA;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {device: device(), user: getUserId()};
  }, A_REPLY);
  expect(after.user).toBeFalsy();  // signed out: no user id ("")
  expect(after.device).not.toContain(A_QUESTION);
  expect(after.device).not.toContain(A_REPLY);
  expect(after.device).not.toMatch(/siru_(chat|sessions|current_session)_patient-a/);
});

test("A's booking answered after A signs out and B signs in leaves nothing of A on the device", async ({ page }) => {
  await page.evaluate(async () => {
    await signIn('patient-a');
    window.bookingA = shoppingPrepareBooking({name: 'Dr A Cardiologist', code: 'dr-a'}, {startTime: '2026-10-05T10:00:00', label: '10:00'}, 'Mon 5 Oct');
  });
  await expect.poll(() => held.has('booking-dr-a')).toBe(true);
  await page.evaluate(async () => { await signOut(); await signIn('patient-b'); });
  held.get('booking-dr-a')();  // A's booking response arrives late
  const after = await page.evaluate(async () => {
    await bookingA;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {device: device(), screen: onScreen(), user: getUserId()};
  });
  expect(after.user).toBe(B);
  for (const where of ['device', 'screen']) {
    expect(after[where], where).not.toContain('Dr A Cardiologist');
    expect(after[where], where).not.toContain('act-dr-a');
  }
  expect(after.device).not.toMatch(/siru_(chat|sessions|current_session)_patient-a/);
});

test("on a profile switch without a sign-out, A's late typed reply is kept in A's history - and still not shown to B", async ({ page }) => {
  // The switch session-isolation.spec.cjs uses: no device wipe in between
  // (nobody signed out), so A's reply is A's to keep - as A's booking is there.
  await page.evaluate(async () => {
    await signIn('patient-a');
    window.turnA = shoppingSubmit(question);
  });
  await expect.poll(() => page.evaluate(() => Boolean(heldTurn))).toBe(true);
  const after = await page.evaluate(async reply => {
    authSave({access_token: 'token-patient-b', expires_at: Date.now() / 1000 + 3600, user: {id: 'patient-b', role: 'buyer', name: 'patient-b'}});
    await applySignedInUser();
    heldTurn({message: reply, trace: {agent: 'care_agent', steps: []}, cards: []});
    await turnA;
    await new Promise(resolve => setTimeout(resolve, 50));
    const keptForA = JSON.stringify(userRead(`siru_chat_patient-a_${userRead('siru_current_session_patient-a', null, sessionStorage)}`, []));
    return {screen: onScreen(), user: getUserId(), keptForA, historyB: JSON.stringify(userHistory('patient-b'))};
  }, A_REPLY);
  expect(after.user).toBe(B);
  expect(after.keptForA).toContain(A_REPLY);  // retention: unchanged by the sign-out fix
  expect(after.screen).not.toContain(A_REPLY);
  expect(after.screen).not.toContain(A_QUESTION);
  expect(after.historyB).not.toContain(A_REPLY);
});

test("A's cart change failing after A signs out and B signs in shows nothing of it to B", async ({ page }) => {
  // shop-flow.js shopFlowCartChange: the error notice of A's cart change (the
  // server's message can name A's product or pharmacy) arrives late.
  const A_ERROR = 'Dolo 650 from Patient A Pharmacy is out of stock';
  await page.evaluate(async () => {
    await signIn('patient-a');
    window.cartChangeA = shopFlowCartChange(() => new Promise((_, reject) => { window.failCartA = reject; }));
  });
  await expect.poll(() => page.evaluate(() => typeof failCartA === 'function')).toBe(true);
  const after = await page.evaluate(async error => {
    await signOut();
    await signIn('patient-b');
    // A 400 the server explains: pharmacyError shows its message as written.
    failCartA(Object.assign(new Error(`400 ${error}`), {status: 400}));
    await cartChangeA;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {screen: onScreen(), device: device(), historyB: JSON.stringify(userHistory('patient-b')), user: getUserId()};
  }, A_ERROR);
  expect(after.user).toBe(B);
  for (const where of ['screen', 'historyB', 'device']) expect(after[where], where).not.toContain(A_ERROR);
});

test("A's add refused for another pharmacy's cart after A signs out and B signs in asks B nothing", async ({ page }) => {
  // shopFlowAdd turns a 409 cart_store into "Switch pharmacy?" for the product added.
  await page.evaluate(async () => {
    await signIn('patient-a');
    // The cart-items call, held: the test answers it later (apiFetch is the page's own).
    const realFetch = apiFetch;
    window.apiFetch = (path, options) => (String(path).includes('/items')
      ? new Promise((_, reject) => { window.releaseAdd = reject; }) : realFetch(path, options));
    window.addA = shopFlowAdd({id: 'dolo-650', name: 'Dolo 650 for Patient A'});
  });
  await expect.poll(() => page.evaluate(() => shopFlowBusy)).toBe(true);
  const after = await page.evaluate(async () => {
    await signOut();
    await signIn('patient-b');
    return null;
  });
  // Release A's add as refused - the route held it: answer it now with the conflict.
  await page.evaluate(() => window.releaseAdd(Object.assign(new Error('409 Your cart is from another pharmacy'),
    {status: 409, detail: {conflict: 'cart_store', message: 'Your cart is from another pharmacy'}})));
  const state = await page.evaluate(async () => {
    await addA;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {pending: shopFlow.confirmSwitch, user: getUserId(), screen: onScreen(), device: device()};
  });
  expect(after).toBeNull();
  expect(state.user).toBe(B);
  expect(state.pending).toBeNull();  // B is not asked to switch pharmacy for A's product
  for (const where of ['screen', 'device']) expect(state[where], where).not.toContain('Dolo 650 for Patient A');
});

test('signing in again starts a new, empty chat for the same user', async ({ page }) => {
  await page.evaluate(async () => {
    await signIn('patient-a');
    window.turnA = shoppingSubmit(question);
  });
  await expect.poll(() => page.evaluate(() => Boolean(heldTurn))).toBe(true);
  const firstSession = await page.evaluate(async reply => {
    heldTurn({message: reply, trace: {agent: 'care_agent', steps: []}, cards: []});
    await turnA;
    return {screen: onScreen(), session: userSession('patient-a')};
  }, A_REPLY);
  expect(firstSession.screen).toContain(A_REPLY);  // A's own reply shows in A's session
  const again = await page.evaluate(async () => {
    await signOut();
    await signIn('patient-a');
    return {screen: onScreen(), session: userSession('patient-a'), user: getUserId()};
  });
  expect(again.user).toBe(A);
  expect(again.screen).not.toContain(A_QUESTION);
  expect(again.screen).not.toContain(A_REPLY);
  expect(again.session).not.toBe(firstSession.session);
});
