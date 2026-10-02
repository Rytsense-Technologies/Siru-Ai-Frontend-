// A voice turn belongs to the user who started it. On a shared device a
// profile switch can happen while a spoken turn is still being answered: the
// earlier user's late turn.result must be dropped - never shown in, saved to,
// or owned by the next user's chat (shopping.js shoppingVoiceEvent).
const { test, expect } = require('@playwright/test');

const QUESTION = 'Patient A: is it safe to take ibuprofen with my blood thinner?';
const REPLY = 'Patient A reply: please check with your doctor before combining them.';

test.beforeEach(async ({ page }) => {
  // No backend: every API call fails fast, as when the server is down.
  await page.route(url => url.pathname.startsWith('/v1/'), route => route.abort());
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    window.signInAs = async id => {
      authSave({access_token: `token-${id}`, expires_at: Date.now() / 1000 + 3600, user: {id, role: 'buyer', name: id}});
      await shoppingResetUser();
    };
    // Everything the page keeps on this device, as one string.
    window.storedText = () => [localStorage, sessionStorage]
      .flatMap(storage => Object.keys(storage).map(key => `${key}=${storage.getItem(key)}`)).join('\n');
  });
});

test("a previous user's late voice result is dropped after a profile switch", async ({ page }) => {
  const result = await page.evaluate(async ({ question, reply }) => {
    await signInAs('patient-a');
    const turnId = 'voice-turn-a';
    shoppingVoiceEvent({type: 'turn.start', turn_id: turnId, user_text: question});
    const startedForA = shop.turns.get(turnId)?.owner;

    await signInAs('patient-b');
    // The turn blocks in B's chat: a delivered result can only render as one
    // (shoppingTurn). Other messages - e.g. the "couldn't connect" notice the
    // page adds with no backend - may still arrive and are not A's data.
    const turnsBefore = [...shopEl.chatMessages.querySelectorAll('.chat-turn')];
    shoppingVoiceEvent({type: 'turn.result', turn_id: turnId, status: 'answered', reply, agent: 'commerce_agent',
      trace: {agent: 'commerce_agent', steps: []}, cards: []});
    await new Promise(resolve => setTimeout(resolve, 50));

    return {
      startedForA,
      turnsUnchanged: [...shopEl.chatMessages.querySelectorAll('.chat-turn')].every((node, i) => node === turnsBefore[i])
        && shopEl.chatMessages.querySelectorAll('.chat-turn').length === turnsBefore.length,
      chatText: shopEl.chatMessages.textContent,
      turnInDom: Boolean(shopEl.chatMessages.querySelector(`[data-turn-id="${turnId}"]`)),
      turnKnown: shop.turns.has(turnId),
      historyB: JSON.stringify(userHistory('patient-b')),
      stored: storedText(),
    };
  }, { question: QUESTION, reply: REPLY });

  expect(result.startedForA).toBe('patient-a');
  // Not rendered in B's chat.
  expect(result.turnsUnchanged).toBe(true);
  expect(result.chatText).not.toContain(REPLY);
  expect(result.chatText).not.toContain(QUESTION);
  expect(result.turnInDom).toBe(false);
  // No turn recreated for (and so owned by) B.
  expect(result.turnKnown).toBe(false);
  // Not saved to B's history, nor anywhere else on the device under B.
  expect(result.historyB).not.toContain(REPLY);
  expect(result.historyB).not.toContain('voice-turn-a');
  expect(result.stored).not.toContain(REPLY);
  expect(result.stored).not.toMatch(/siru_chat_patient-b_[^=]*=[^\n]*voice-turn-a/);
});

test('voice turns arriving mid-switch, before the reset, are dropped', async ({ page }) => {
  const result = await page.evaluate(async ({ question, reply }) => {
    await signInAs('patient-a');
    shoppingVoiceEvent({type: 'turn.start', turn_id: 'voice-turn-a', user_text: question});
    // The login changed (getUserId() is B) but shoppingResetUser hasn't run yet.
    authSave({access_token: 'token-patient-b', expires_at: Date.now() / 1000 + 3600,
      user: {id: 'patient-b', role: 'buyer', name: 'patient-b'}});
    shoppingVoiceEvent({type: 'turn.result', turn_id: 'voice-turn-a', status: 'answered', reply, cards: []});
    shoppingVoiceEvent({type: 'turn.start', turn_id: 'voice-turn-a2', user_text: question});
    return {
      pendingA: shop.turns.get('voice-turn-a')?.record.status,
      lateStart: shop.turns.has('voice-turn-a2'),
      historyB: JSON.stringify(userHistory('patient-b')),
    };
  }, { question: QUESTION, reply: REPLY });

  expect(result.pendingA).toBe('pending');  // A's turn got no reply under B
  expect(result.lateStart).toBe(false);
  expect(result.historyB).toBe('[]');
});

test("the current user's own voice turn is still shown and saved", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await signInAs('patient-a');
    await signInAs('patient-b');
    shoppingVoiceEvent({type: 'turn.start', turn_id: 'voice-turn-b', user_text: 'Patient B question'});
    shoppingVoiceEvent({type: 'turn.result', turn_id: 'voice-turn-b', status: 'answered', reply: 'Patient B reply', cards: []});
    await new Promise(resolve => setTimeout(resolve, 50));
    const saved = userHistory('patient-b').find(message => message.id === 'voice-turn-b');
    return {
      owner: shop.turns.get('voice-turn-b')?.owner,
      chatText: shopEl.chatMessages.textContent,
      saved: saved && {status: saved.status, user: saved.user, reply: saved.reply},
      historyA: JSON.stringify(userHistory('patient-a')),
    };
  });

  expect(result.owner).toBe('patient-b');
  expect(result.chatText).toContain('Patient B question');
  expect(result.chatText).toContain('Patient B reply');
  expect(result.saved).toEqual({status: 'answered', user: 'Patient B question', reply: 'Patient B reply'});
  expect(result.historyA).not.toContain('Patient B');
});
