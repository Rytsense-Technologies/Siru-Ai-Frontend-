// Multi-user voice isolation, end to end, against the REAL stack: this page's real app.js /
// shopping.js -> the real /v1/voice/token -> the real LiveKit server -> the real voice worker
// (Sarvam STT -> the graph -> Sarvam TTS) and back. It proves a voice reply meant for one user
// never reaches the next user on a shared device:
//   A  A's real turn.result is held at the worker until B has signed in (normal sign-out):
//      nothing of A reaches B's chat, history, storage, inspector, cart or booking state.
//   B  B's own new voice request after the switch works normally and is saved to B.
//   C  A's LiveKit connection is kept open past the switch (a hung teardown): A's late
//      events DO reach the browser, and app.js drops them before shoppingVoiceEvent.
//
// The race is made deterministic by a worker-side hook (voice-isolation-hook/sitecustomize.py,
// loaded into the worker only, via PYTHONPATH): it holds A's turn.result at the worker's
// publish_data until this test releases it. Released, it is the worker's real message.
//
// In the page (test-only, passive except the microphone and test C's deferred disconnect):
// a synthetic microphone (WebAudio, silent until a clip is spoken), a second DataReceived
// listener on every LiveKit Room recording what arrives, and a pass-through wrapper on
// shoppingVoiceEvent recording what reaches the shopping layer.
//
// Skipped unless E2E_VOICE_ISOLATION=1 - never a pass by default. Needs LiveKit, the voice
// worker started WITH the hook (run-voice-isolation.ps1 does both), Sarvam credits, and the
// two clips (make-voice-clips.ps1). Each run makes a few short Sarvam calls.
//   E2E_VOICE_GATE_DIR  the hook's directory (worker and test must agree; the runner sets it)
//   E2E_VOICE_CLIPS     a.wav / b.wav
// Both default to %TEMP%\siru-voice-isolation\{gate,clips}: outside test-results, which
// Playwright empties at the start of every run.
//   E2E_HEADED=1, PW_CHANNEL=msedge|chrome   watch it run
// Writes %TEMP%\siru-voice-isolation\evidence.json (kept across runs, unlike test-results).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect, chromium } = require('@playwright/test');
const { env, signIn } = require('./helpers.cjs');

const ENABLED = process.env.E2E_VOICE_ISOLATION === '1';
const WORK = path.join(os.tmpdir(), 'siru-voice-isolation');
const GATE = path.resolve(process.env.E2E_VOICE_GATE_DIR || path.join(WORK, 'gate'));
const CLIPS = path.resolve(process.env.E2E_VOICE_CLIPS || path.join(WORK, 'clips'));
const OUT = path.join(WORK, 'evidence.json');
const clip = name => fs.readFileSync(path.join(CLIPS, `${name}.wav`)).toString('base64');
const hook = () => (fs.existsSync(path.join(GATE, 'worker-publish.jsonl'))
  ? fs.readFileSync(path.join(GATE, 'worker-publish.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
const evidence = {};
const save = () => fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));

async function instrument(page) {
  page.on('console', message => {
    const text = message.text();
    if (/^siru:/.test(text)) (evidence.console ||= []).push(`${new Date().toISOString()} ${text}`);
  });
  await page.addInitScript(clips => {
    window.__clips = clips;
    window.__evidence = {data: [], events: []};
    let audio = null;
    const outputs = [];
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints || !constraints.audio) return realGetUserMedia(constraints);
      audio = audio || new AudioContext({sampleRate: 48000});
      const output = audio.createMediaStreamDestination();
      outputs.push(output);
      return output.stream;  // silent until window.__speak plays a clip into it
    };
    window.__speak = async name => {
      await audio.resume();
      const bytes = Uint8Array.from(atob(window.__clips[name]), c => c.charCodeAt(0));
      const buffer = await audio.decodeAudioData(bytes.buffer);
      const source = audio.createBufferSource();
      source.buffer = buffer;
      for (const output of outputs) source.connect(output);
      source.start();
      return buffer.duration;
    };
    document.addEventListener('DOMContentLoaded', () => {
      const RealRoom = LivekitClient.Room;
      const rooms = window.__rooms = [];
      LivekitClient.Room = class extends RealRoom {
        constructor(...args) {
          super(...args);
          const index = rooms.push(this) - 1;
          // Registered before app.js's own handler: records every message as it arrives.
          this.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
            let message = {};
            try { message = JSON.parse(new TextDecoder().decode(payload)); } catch {}
            window.__evidence.data.push({t: Date.now(), room: index, roomName: this.name, topic, from: participant && participant.identity,
              type: message.type, turn_id: message.turn_id, user: getUserId(), generation: shop.generation,
              isActiveVoiceRoom: this === voiceRoom});
          });
          this.on(LivekitClient.RoomEvent.Disconnected, () =>
            window.__evidence.events.push({t: Date.now(), room: index, roomName: this.name, event: 'livekit_disconnected'}));
          // livekit-client defines disconnect on each instance (a class field), so it is wrapped here.
          const realDisconnect = this.disconnect;
          this.disconnect = async (...args) => {
            if (window.__deferDisconnect) {
              window.__evidence.events.push({t: Date.now(), room: index, roomName: this.name, event: 'disconnect_DEFERRED_by_test'});
              (window.__deferred = window.__deferred || []).push(() => realDisconnect.apply(this, args));
              return;
            }
            window.__evidence.events.push({t: Date.now(), room: index, roomName: this.name, event: 'disconnect_called'});
            return realDisconnect.apply(this, args);
          };
        }
      };
      const realVoiceEvent = window.shoppingVoiceEvent;
      window.shoppingVoiceEvent = message => {
        window.__evidence.events.push({t: Date.now(), event: 'reached_shoppingVoiceEvent', type: message && message.type,
          turn_id: message && message.turn_id, user: getUserId(), generation: shop.generation});
        return realVoiceEvent(message);
      };
    });
  }, {a: clip('a'), b: clip('b')});
}

async function formSignIn(page, account) {
  await expect(page.locator('#loginEmail')).toBeVisible();
  await page.fill('#loginEmail', account.email);
  await page.fill('#loginPassword', account.password);
  await page.click('#loginBtn');
  await expect(page.locator('#appView')).toBeVisible();
  await page.waitForSelector('dialog[open]', {timeout: 8000}).catch(() => null);
  for (let i = 0; i < 5 && await page.$('dialog[open]'); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
}

async function signOutViaMenu(page) {
  await page.click('#userMenu > summary');
  await page.click('#logoutBtn');
  await expect(page.locator('#loginEmail')).toBeVisible();
}

const state = page => page.evaluate(() => ({
  user: getUserId(), currentUser: shop.currentUser, generation: shop.generation, session: shoppingSessionId,
  voiceRoom: voiceRoom ? voiceRoom.name : null, turns: [...shop.turns.values()].map(t => ({id: t.id, owner: t.owner, generation: t.generation})),
}));

// Everything B's session holds: on screen, in B's history, under B's keys on this device, the inspector, cart.
const bView = page => page.evaluate(() => {
  const id = getUserId();
  return {
    chat: shopEl.chatMessages.textContent,
    turnIds: [...shopEl.chatMessages.querySelectorAll('.chat-turn')].map(n => n.dataset.turnId),
    history: JSON.stringify(userHistory(id)),
    storage: [localStorage, sessionStorage].flatMap(s => Object.keys(s).map(k => `${k}=${s.getItem(k)}`)).join('\n'),
    inspector: shopEl.activityList.textContent + '|' + shopEl.inspectorTurn.textContent,
    // The cart's content - not its version, which is this page's own read counter (pharmacy-api.js readSequence).
    cart: JSON.stringify(shop.cart && {items: shop.cart.items, storeId: shop.cart.storeId, total_paise: shop.cart.total_paise}),
    confirmCards: shopEl.chatMessages.querySelectorAll('.confirm-card').length,
  };
});

async function untilHook(predicate, what, seconds = 180) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const hit = hook().find(predicate);
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`worker hook: no ${what} in ${seconds}s`);
}

// Start the call, wait for the real greeting through LiveKit, then speak a clip.
async function speakTurn(page, clipName) {
  const token = page.waitForResponse(r => r.url().includes('/v1/voice/token'), {timeout: 60_000});
  await page.click('#micBtn');
  expect((await token).status()).toBe(200);
  await expect.poll(() => page.evaluate(() => window.__evidence.data.some(d => d.type === 'reply' && d.isActiveVoiceRoom)),
    {timeout: 90_000, message: 'the worker\'s greeting over LiveKit'}).toBe(true);
  await page.waitForTimeout(9000);  // let the greeting finish speaking
  await page.evaluate(name => window.__speak(name), clipName);
}

test.describe.serial('real stack: multi-user voice isolation', () => {
  test.skip(!ENABLED, 'needs LiveKit, the voice worker with the isolation hook and Sarvam (E2E_VOICE_ISOLATION=1, see run-voice-isolation.ps1) - not run, not passed');
  test.setTimeout(600_000);
  let browser, page, A, B;
  test.beforeAll(async () => {
    for (const name of ['a', 'b']) {
      expect(fs.existsSync(path.join(CLIPS, `${name}.wav`)), `${path.join(CLIPS, `${name}.wav`)} (make-voice-clips.ps1)`).toBe(true);
    }
    fs.mkdirSync(GATE, {recursive: true});
    [A, B] = env().accounts;
    // Its own browser, as 05-voice.e2e.cjs: the audio clips play without a user gesture.
    browser = await chromium.launch({
      channel: process.env.PW_CHANNEL || undefined,
      headless: process.env.E2E_HEADED !== '1',
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
    });
    page = await (await browser.newContext({permissions: ['microphone'], viewport: {width: 1280, height: 800}})).newPage();
    await instrument(page);
    evidence.stack = {api: env().api, web: env().web, gate: GATE};
  });
  test.afterAll(async () => {
    if (ENABLED) {
      fs.mkdirSync(WORK, {recursive: true});
      save();
    }
    await browser?.close();
  });

  test('A: A\'s real turn.result, held until after B signs in, reaches nothing of B', async () => {
    await signIn(page, A);
    const aState = await state(page);
    fs.writeFileSync(path.join(GATE, `hold-${aState.user}`), 'hold');
    await speakTurn(page, 'a');
    // The worker took A's request: its real turn.start arrived and A's turn is on screen.
    const aStart = await untilHook(h => h.event === 'published' && h.type === 'turn.start' && h.destination.includes(aState.user), 'A turn.start');
    await expect(page.locator(`.chat-turn[data-turn-id="${aStart.turn_id}"] .chat-bubble.user`)).toBeVisible({timeout: 30_000});
    const aHeld = await untilHook(h => h.event === 'held' && h.turn_id === aStart.turn_id, 'A turn.result held');
    const aBefore = await state(page);
    // Switch: sign out A (the real menu), sign in B in the same tab.
    await signOutViaMenu(page);
    const afterSignOut = await state(page);
    await formSignIn(page, B);
    const bState = await state(page);
    const bFresh = await bView(page);
    const bCartBefore = bFresh.cart;
    // Now let A's real result go: worker -> LiveKit -> (A's browser connection, if any).
    fs.writeFileSync(path.join(GATE, `release-${aState.user}`), 'go');
    const aOutcome = await untilHook(h => ['published', 'publish_failed'].includes(h.event) && h.type === 'turn.result' && h.turn_id === aStart.turn_id, 'A turn.result outcome', 60);
    await page.waitForTimeout(8000);  // LiveKit delivery time
    const b = await bView(page);
    const browser = await page.evaluate(() => window.__evidence);
    Object.assign(evidence, {testA: {
      aUser: aState.user, bUser: bState.user, aGeneration: aBefore.generation, afterSignOut, bGeneration: bState.generation,
      aRoom: aBefore.voiceRoom, aTurnId: aStart.turn_id, aTranscript: aStart.user_text, aReply: aOutcome.reply,
      workerPublishSender: aStart.sender, workerPublishTarget: aStart.destination, held: aHeld, outcome: aOutcome,
      bFresh: {turnIds: bFresh.turnIds, history: bFresh.history},
      browserDataOnARoomAfterRelease: browser.data.filter(d => d.roomName === aBefore.voiceRoom && d.t >= aOutcome.t * 1000 - 1000),
      roomEvents: browser.events.filter(e => e.event !== 'reached_shoppingVoiceEvent'),
      reachedShoppingAfterSwitch: browser.events.filter(e => e.event === 'reached_shoppingVoiceEvent' && e.user === bState.user),
      b: {turnIds: b.turnIds, historyLength: JSON.parse(b.history).length, confirmCards: b.confirmCards, cartUnchanged: b.cart === bCartBefore},
    }});
    save();
    expect(bState.user).not.toBe(aState.user);
    expect(bState.generation).toBeGreaterThan(aBefore.generation);
    expect(afterSignOut.voiceRoom).toBeNull();
    expect(bFresh.turnIds).toEqual([]);
    for (const [field, text] of Object.entries({chat: b.chat, history: b.history, storage: b.storage, inspector: b.inspector})) {
      expect(text, field).not.toContain(aStart.turn_id);
      expect(text, field).not.toMatch(/dolo/i);
      if (aOutcome.reply) expect(text, field).not.toContain(aOutcome.reply.slice(0, 40));
    }
    expect(b.turnIds).toEqual([]);
    expect(b.cart).toBe(bCartBefore);
    expect(b.confirmCards).toBe(0);
    expect(evidence.testA.reachedShoppingAfterSwitch.filter(e => e.turn_id === aStart.turn_id)).toEqual([]);
  });

  test('B: B\'s own new voice request works normally after the reset', async () => {
    const before = await state(page);
    await speakTurn(page, 'b');
    const bStart = await untilHook(h => h.event === 'published' && h.type === 'turn.start' && h.destination.includes(before.user), 'B turn.start');
    const bResult = await untilHook(h => h.event === 'published' && h.type === 'turn.result' && h.turn_id === bStart.turn_id, 'B turn.result');
    const turn = page.locator(`.chat-turn[data-turn-id="${bStart.turn_id}"]`);
    await expect(turn.locator('.chat-bubble.user')).toBeVisible({timeout: 30_000});
    await expect(turn.locator('.chat-bubble.assistant')).toBeVisible({timeout: 30_000});
    const after = await state(page);
    const b = await bView(page);
    const saved = JSON.parse(b.history).find(m => m.id === bStart.turn_id);
    Object.assign(evidence, {testB: {bUser: before.user, bRoom: after.voiceRoom, bTurnId: bStart.turn_id, transcript: bStart.user_text,
      reply: bResult.reply, workerPublishTarget: bStart.destination, turn: after.turns.find(t => t.id === bStart.turn_id), generation: after.generation,
      saved: saved && {status: saved.status, user: saved.user, reply: (saved.reply || '').slice(0, 120)},
      inStorage: b.storage.includes(bStart.turn_id)}});
    save();
    expect(after.voiceRoom).toMatch(new RegExp(`^voice-${before.user}-`));
    expect(after.voiceRoom).not.toBe(evidence.testA.aRoom);
    expect(evidence.testB.turn).toEqual({id: bStart.turn_id, owner: before.user, generation: after.generation});
    expect(saved?.status).toBe('answered');
    expect(b.storage).toContain(bStart.turn_id);
    expect(b.chat).not.toMatch(/dolo/i);
    await page.click('#micBtn');  // end B's call
  });

  test('C: A\'s connection left open past the switch - every late A event is dropped in app.js', async () => {
    await signOutViaMenu(page);
    await formSignIn(page, A);
    const aState = await state(page);
    for (const f of [`release-${aState.user}`]) if (fs.existsSync(path.join(GATE, f))) fs.unlinkSync(path.join(GATE, f));
    await speakTurn(page, 'a');
    const aStart = await untilHook(h => h.event === 'published' && h.type === 'turn.start' && h.destination.includes(aState.user)
      && h.turn_id !== evidence.testA.aTurnId, 'A (second) turn.start');
    await untilHook(h => h.event === 'held' && h.turn_id === aStart.turn_id, 'A (second) turn.result held');
    const aBefore = await state(page);
    // The teardown hangs (test-only): A's real LiveKit connection stays up while A signs out and B signs in.
    await page.evaluate(() => { window.__deferDisconnect = true; });
    await signOutViaMenu(page);
    await formSignIn(page, B);
    const bState = await state(page);
    const switchedAt = Date.now();
    fs.writeFileSync(path.join(GATE, `release-${aState.user}`), 'go');
    await untilHook(h => ['published', 'publish_failed'].includes(h.event) && h.type === 'turn.result' && h.turn_id === aStart.turn_id, 'A (second) result outcome', 60);
    // A speaks again on the still-open connection: whatever the worker sends for it arrives late too.
    await page.evaluate(() => window.__speak('a'));
    await page.waitForTimeout(25_000);
    const browser = await page.evaluate(() => window.__evidence);
    const lateOnA = browser.data.filter(d => d.roomName === aBefore.voiceRoom && d.t >= switchedAt);
    const reached = browser.events.filter(e => e.event === 'reached_shoppingVoiceEvent' && e.t >= switchedAt);
    const b = await bView(page);
    Object.assign(evidence, {testC: {aUser: aState.user, bUser: bState.user, aRoom: aBefore.voiceRoom, aGeneration: aBefore.generation,
      bGeneration: bState.generation, aTurnId: aStart.turn_id, lateEventsDeliveredToBrowserOnARoom: lateOnA,
      reachedShoppingVoiceEventAfterSwitch: reached,
      workerAfterSwitch: hook().filter(h => h.t * 1000 >= switchedAt - 2000 && (h.destination || []).includes(aState.user)),
      roomEvents: browser.events.filter(e => e.event !== 'reached_shoppingVoiceEvent' && e.t >= switchedAt - 60_000),
      b: {turnIds: b.turnIds, historyLength: JSON.parse(b.history).length}}});
    save();
    await page.evaluate(async () => { window.__deferDisconnect = false; for (const run of window.__deferred || []) await run(); });
    expect(lateOnA.length, 'late A events actually reached the browser over LiveKit').toBeGreaterThan(0);
    expect(lateOnA.every(d => d.isActiveVoiceRoom === false && d.user === bState.user)).toBe(true);
    expect(reached).toEqual([]);  // none got past app.js's room/user filter
    for (const text of [b.chat, b.history, b.storage, b.inspector]) {
      expect(text).not.toContain(aStart.turn_id);
      expect(text).not.toMatch(/dolo/i);
    }
    expect(b.turnIds).toEqual([]);
  });
});
