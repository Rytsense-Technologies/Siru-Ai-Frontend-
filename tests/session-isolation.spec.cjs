// A user's in-flight work never lands in the next user's session on a shared
// device: voice turns from a replaced LiveKit room (app.js startVoiceSession's
// DataReceived filter) and a booking prepared before a profile switch
// (shopping.js shoppingPrepareBooking). The page's own voice and booking code
// runs; only the network edges are stood in for: the voice token and the
// bookings API (held open until the test releases them), the microphone
// prompt, and the LiveKit Room (a stand-in that emits what the worker sends).
const { test, expect } = require('@playwright/test');

const A = 'patient-a', B = 'patient-b';
const A_TEXT = 'Patient A asks about heart medication';
const A_REPLY = 'Patient A reply about heart medication';

let held;  // booking responses held open, by doctor code

test.beforeEach(async ({ page }) => {
  held = new Map();
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'};
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS' && ['/v1/voice/token', '/v1/actions/bookings'].includes(path)) {
      return route.fulfill({status: 204, headers: cors});
    }
    if (path === '/v1/voice/token') {
      return route.fulfill({headers: cors, json: {token: 't', url: 'wss://livekit.test', room_name: `voice-${Date.now()}`}});
    }
    if (path === '/v1/actions/bookings') {
      const {doctor_code: code} = request.postDataJSON();
      await new Promise(release => held.set(code, release));
      return route.fulfill({headers: cors, json: {card: {kind: 'confirm_action', actionId: `act-${code}`, title: `Book ${code}`,
        rows: [{label: 'Doctor', value: `Doctor for ${code}`}, {label: 'When', value: 'Mon 10:00'}]}}});
    }
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    // The LiveKit Room: records what the page does with it and emits the worker's messages.
    window.rooms = [];
    window.holdConnect = false;
    LivekitClient.Room = class {
      constructor() {
        this.handlers = {};
        this.disconnected = false;
        this.remoteParticipants = new Map([['siru-agent', {identity: 'siru-agent'}]]);
        this.localParticipant = {setMicrophoneEnabled: async () => {}, audioTrackPublications: new Map()};
        rooms.push(this);
      }
      on(event, handler) { (this.handlers[event] ||= []).push(handler); return this; }
      emit(event, ...args) { for (const handler of this.handlers[event] || []) handler(...args); }
      async connect() { if (holdConnect) await new Promise(resolve => { this.finishConnect = resolve; }); }
      async disconnect() { this.disconnected = true; }
      async startAudio() {}
    };
    window.worker = (room, message) => room.emit(LivekitClient.RoomEvent.DataReceived,
      new TextEncoder().encode(JSON.stringify(message)), {identity: 'siru-agent'}, 0, 'siru.turn');
    navigator.mediaDevices.getUserMedia = async () => ({getTracks: () => []});
    buyerVoiceSurface.ready = async () => {};  // the pharmacy pre-connect: not what is tested here
    window.signInAs = async id => {
      authSave({access_token: `token-${id}`, expires_at: Date.now() / 1000 + 3600, user: {id, role: 'buyer', name: id}});
      await applySignedInUser();
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    };
    // What B's session holds: on screen, in B's history, and anywhere on the device under B.
    window.seenByB = () => ({
      chat: shopEl.chatMessages.textContent,
      turns: [...shopEl.chatMessages.querySelectorAll('.chat-turn')].map(node => node.dataset.turnId),
      history: JSON.stringify(userHistory('patient-b')),
      stored: [localStorage, sessionStorage].flatMap(storage => Object.keys(storage)
        .filter(key => key.includes('patient-b')).map(key => storage.getItem(key))).join('\n'),
      owners: [...shop.turns.values()].map(turn => turn.owner),
    });
  });
});

test('B: voice events from A\'s replaced room - connected, or still connecting - never reach B', async ({ page }) => {
  const result = await page.evaluate(async ({ text, reply }) => {
    await signInAs('patient-a');
    // A's call, connected: A starts a turn.
    await startVoiceSession();
    const roomA = rooms.at(-1);
    worker(roomA, {type: 'turn.start', turn_id: 'a-1', user_text: text});
    const aTurnShown = Boolean(shop.turns.get('a-1'));
    // A second call for A whose connection is still pending (the room being replaced).
    await stopVoiceSession();
    holdConnect = true;
    const connecting = startVoiceSession();
    await new Promise(resolve => setTimeout(resolve, 0));
    const roomA2 = rooms.at(-1);
    // Switch to B while A2 is still connecting.
    await signInAs('patient-b');
    roomA2.finishConnect?.();
    await connecting;
    // Everything A's worker might still send, from either room.
    for (const room of [roomA, roomA2]) {
      worker(room, {type: 'turn.result', turn_id: 'a-1', status: 'answered', reply, cards: []});
      worker(room, {type: 'turn.start', turn_id: 'a-2', user_text: text});
      worker(room, {type: 'turn.result', turn_id: 'a-2', status: 'answered', reply, cards: []});
      worker(room, {type: 'reply', reply_id: 'r-1', text: reply});
      worker(room, {type: 'noise', noise_id: 'n-1', text, reason: 'filler', at: Date.now() / 1000});
      worker(room, {type: 'turn.memory', turn_id: 'a-1', status: 'saved', count: 1});
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    return {aTurnShown, roomsDisconnected: [roomA.disconnected, roomA2.disconnected], voiceRoomIsA: [roomA, roomA2].includes(voiceRoom),
      activity: shopEl.activityList.textContent, ...seenByB()};
  }, { text: A_TEXT, reply: A_REPLY });
  expect(result.aTurnShown).toBe(true);  // A's own turn did show for A
  expect(result.roomsDisconnected).toEqual([true, true]);
  expect(result.voiceRoomIsA).toBe(false);
  for (const field of ['chat', 'history', 'stored', 'activity']) {
    expect(result[field], field).not.toContain(A_TEXT);
    expect(result[field], field).not.toContain(A_REPLY);
  }
  expect(result.turns).toEqual([]);
  expect(result.owners).toEqual([]);
});

test('C: B\'s own voice turn after the reset shows and is saved normally', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await signInAs('patient-a');
    await startVoiceSession();
    await signInAs('patient-b');
    await startVoiceSession();
    const roomB = rooms.at(-1);
    worker(roomB, {type: 'turn.start', turn_id: 'b-1', user_text: 'Patient B question'});
    worker(roomB, {type: 'turn.result', turn_id: 'b-1', status: 'answered', reply: 'Patient B answer', cards: []});
    await new Promise(resolve => setTimeout(resolve, 50));
    const saved = userHistory('patient-b').find(message => message.id === 'b-1');
    return {owner: shop.turns.get('b-1')?.owner, saved: saved && {user: saved.user, reply: saved.reply, status: saved.status}, ...seenByB()};
  });
  expect(result.owner).toBe(B);
  expect(result.chat).toContain('Patient B question');
  expect(result.chat).toContain('Patient B answer');
  expect(result.saved).toEqual({user: 'Patient B question', reply: 'Patient B answer', status: 'answered'});
});

test('D + E: A\'s booking answered after a switch reaches nothing of B; B\'s own booking works', async ({ page }) => {
  await page.evaluate(async () => {
    await signInAs('patient-a');
    window.bookingA = shoppingPrepareBooking({name: 'Dr A Cardiologist', code: 'dr-a'}, {startTime: '2026-10-05T10:00:00', label: '10:00'}, 'Mon 5 Oct');
  });
  await expect.poll(() => held.has('dr-a')).toBe(true);  // A's request is in flight
  await page.evaluate(async () => {
    await signInAs('patient-b');
    // B starts a booking of their own, also in flight.
    window.bookingB = shoppingPrepareBooking({name: 'Dr B Dermatologist', code: 'dr-b'}, {startTime: '2026-10-06T11:00:00', label: '11:00'}, 'Tue 6 Oct');
  });
  await expect.poll(() => held.has('dr-b')).toBe(true);
  held.get('dr-a')();  // A's response arrives late
  const afterA = await page.evaluate(async () => {
    await bookingA;
    await new Promise(resolve => setTimeout(resolve, 50));
    const ownerSaved = userHistory('patient-a').find(message => (message.user || '').includes('Dr A'));
    return {busy: shop.busy, ownerSaved: ownerSaved && {status: ownerSaved.status, card: ownerSaved.cards?.[0]?.actionId}, ...seenByB()};
  });
  // A's prepared booking is kept for A - in A's own history, not lost and not B's.
  expect(afterA.ownerSaved).toEqual({status: 'answered', card: 'act-dr-a'});
  // D: nothing of A's booking in B's chat, B's history, B's storage or B's turns.
  for (const field of ['chat', 'history', 'stored']) {
    expect(afterA[field], field).not.toContain('Dr A Cardiologist');
    expect(afterA[field], field).not.toContain('act-dr-a');
    expect(afterA[field], field).not.toContain('Doctor for dr-a');
  }
  expect(afterA.owners.every(owner => owner === B)).toBe(true);
  expect(afterA.busy).toBe(true);  // B's own booking is still in flight: A's response must not release it
  held.get('dr-b')();
  const afterB = await page.evaluate(async () => {
    await bookingB;
    const saved = userHistory('patient-b').find(message => (message.user || '').includes('Dr B'));
    return {busy: shop.busy, saved: saved && {status: saved.status, card: saved.cards?.[0]?.actionId}, ...seenByB()};
  });
  // E: B's booking shows, with its confirm card, and is saved to B.
  expect(afterB.chat).toContain('Book Dr B Dermatologist');
  expect(afterB.chat).toContain('Doctor for dr-b');
  expect(afterB.saved).toEqual({status: 'answered', card: 'act-dr-b'});
  expect(afterB.busy).toBe(false);
  expect(afterB.chat).not.toContain('Dr A Cardiologist');
});
