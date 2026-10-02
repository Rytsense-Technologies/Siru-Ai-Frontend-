// Standalone development frontend - talks directly to the API, no build step.

// The API server chosen under "Server settings" - kept for this browser (every
// tab, after a reload), so each developer on the LAN sets it once.
function savedApiBase() {
  for (const storage of [localStorage, sessionStorage]) {
    try { const value = storage.getItem("pharmacy_api_base"); if (value) return value; } catch {}
  }
  return "";
}
// The backend's address: config.js when it names one; otherwise the "Server
// settings" address, else this host's port 8010 (the local API).
const CONFIGURED_API_BASE = String(window.SIRU_CONFIG?.apiBaseUrl || window.MEDICINE_API_BASE || '').trim();
const LOCAL_API_PORT = 8010;
const API_BASE = (CONFIGURED_API_BASE || savedApiBase() ||
  `${location.protocol === 'https:' ? 'https:' : 'http:'}//${!location.hostname || location.hostname === 'localhost' ? '127.0.0.1' : location.hostname}:${LOCAL_API_PORT}`).replace(/\/+$/, '');
const DOMAIN = "medical";
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes, per requirement
// The voice worker's turns (multi_agent_framework/voice/worker.py, TURN_TOPIC):
// turn.start (the user's message), turn.result (the reply, its cards and its
// activity), reply (the greeting, "say that again").
const TURN_TOPIC = "siru.turn";
// The assistant out of view: left, unless the room is reconnecting (checked
// after ASSISTANT_LEFT_CHECK_MS) - then not back ASSISTANT_REJOIN_MS after
// the reconnect = left.
const ASSISTANT_LEFT_CHECK_MS = 2000;
const ASSISTANT_REJOIN_MS = 8000;

const el = {
  notifBell: document.getElementById("notifBell"),
  notifCount: document.getElementById("notifCount"),
  notifPanel: document.getElementById("notifPanel"),
  notifList: document.getElementById("notifList"),
  pollStatus: document.getElementById("pollStatus"),
  checkNowBtn: document.getElementById("checkNowBtn"),
  askForm: document.getElementById("askForm"),
  askInput: document.getElementById("askInput"),
  askResult: document.getElementById("askResult"),
  productList: document.getElementById("productList"),
  apiBaseLabel: document.getElementById("apiBaseLabel"),
  toastContainer: document.getElementById("toastContainer"),
  micBtn: document.getElementById("micBtn"),
  micIcon: document.getElementById("micIcon"),
  micLabel: document.getElementById("micLabel"),
  muteBtn: document.getElementById("muteBtn"),
  muteIcon: document.getElementById("muteIcon"),
  muteLabel: document.getElementById("muteLabel"),
  voiceStatus: document.getElementById("voiceStatus"),
  micFilters: document.getElementById("micFilters"),
};

let secondsUntilNextPoll = POLL_INTERVAL_MS / 1000;
// ids whose status was already "notified" as of the last time we looked -
// lets us tell "still notified from before" apart from "just became
// notified", so toasts only fire for genuinely new events, not on every
// poll/reload. Seeded (not toasted) on the very first load per user.
let knownNotifiedIds = null;

function getUserId() {
  return currentUserId || '';
}

// The login token is the only credential the page holds: the backend takes
// the user from it, never from a user id the page sends.
function apiHeaders() {
  return { "Content-Type": "application/json", ...(authToken() ? {Authorization: `Bearer ${authToken()}`} : {}) };
}

// Longer than the server's own turn budget (request_timeout_seconds, 60 s): a
// request that hangs past it (a stalled connection) fails with a message
// instead of leaving the chat busy for good.
const API_TIMEOUT_MS = 90000;

function apiTimeoutError(path) {
  const error = new Error("The server took too long to answer. Please try again.");
  error.userMessage = true;
  error.status = 0;
  error.path = path;
  return error;
}

async function apiFetch(path, options = {}) {
  const token = authToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, signal: controller.signal,
      headers: { ...apiHeaders(), ...options.headers } });
  } catch (err) {
    if (err?.name === 'AbortError') throw apiTimeoutError(path);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  // Expired or revoked: back to the sign-in screen (once - later calls made
  // with the same old token land here too).
  if (res.status === 401 && token && token === authToken()) authExpired();
  if (!res.ok) {
    let body = await res.text().catch(() => "");
    let detail = null;
    let requestId = '';
    try {
      const data = JSON.parse(body);
      detail = data.detail ?? null;
      body = typeof detail === 'string' ? detail : (detail?.message || data.error || res.statusText);
      requestId = typeof data.request_id === 'string' ? data.request_id : '';
    } catch {}
    const error = new Error(`${res.status} ${body || res.statusText}`);
    error.status = res.status;
    error.path = path;
    error.detail = detail;  // a structured detail, e.g. {conflict: "cart_store", message}
    error.requestId = requestId || res.headers.get('X-Request-ID') || '';  // matches the server's log line
    throw error;
  }
  return res.json();
}

// ---------- Ask the assistant ----------

el.askForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (shop.busy) return;
  const userInput = el.askInput.value.trim();
  // A photo waiting above the input (pasted or picked) goes first, then any typed text.
  const photo = photoPending?.file || null;
  if (!userInput && !photo) return;
  el.askInput.value = "";
  if (photo) {
    photoClear();
    await shoppingSendPhoto(photo);
  }
  if (userInput) await shoppingSubmit(userInput);
});

function renderAskResult(data) {
  const answer = data.final_output || "(no answer returned)";
  let html = `<div class="answer">${escapeHtml(answer)}</div>`;

  if (data.suggestion) {
    html += `<div class="suggestion">${escapeHtml(data.suggestion)}</div>`;
  }

  if (data.intent && typeof data.intent === "object") {
    const tags = ["domain", "intent", "action", "entity"]
      .filter((k) => data.intent[k])
      .map((k) => `<span class="tag">${k}: ${escapeHtml(String(data.intent[k]))}</span>`)
      .join("");
    if (tags) html += `<div class="intent-tags">${tags}</div>`;
  }

  if (data.product_id != null) {
    const entity = (data.intent && data.intent.entity) || "this item";
    html += `<button class="buy-btn" data-product-id="${escapeHtml(data.product_id)}" data-product-name="${escapeHtml(entity)}">Buy (demo)</button>`;
  }

  el.askResult.className = "ask-result";
  el.askResult.innerHTML = html;

  const buyBtn = el.askResult.querySelector(".buy-btn");
  if (buyBtn) buyBtn.addEventListener("click", () => purchaseProduct(buyBtn));
}

// ---------- Voice (LiveKit + Sarvam, real-time voice-to-voice) -------------
//
// micBtn starts/ends the whole session. Once connected, muteBtn lets you
// manually turn the mic on/off without ending the session - e.g. speak,
// then mute while you wait for the assistant's reply, then unmute to talk
// again. Continuous listening still works if you never touch muteBtn: the
// worker's Silero VAD detects when you've stopped talking on its own.

let voiceRoom = null;
let micMuted = false;

// One voice call path for both chats: the same LiveKit room, speech
// recognition and voice worker. What differs is where the call's UI lives - a
// buyer's pharmacy chat, or a merchant's assistant (merchant.js). The worker
// picks the merchant turn from the verified account's role, never from here.
const buyerVoiceSurface = {
  get micBtn() { return el.micBtn; },
  get micIcon() { return el.micIcon; },
  get micLabel() { return el.micLabel; },
  generation: () => shop.generation,
  async ready() {
    // Connect to the pharmacy first when the page hasn't yet (API still
    // starting, profile switched) instead of refusing to start voice.
    await shoppingEnsureConnected();
    await shoppingSelectionReady();
  },
  // chat_session_id: the conversation the typed chat is in - created now if
  // the user speaks before typing - so spoken and typed turns belong to one
  // conversation (worker: conversation_id), and every mic session of it shares
  // one greeting and one pharmacy choice (worker: the greeting claim).
  sessionQuery: () => {
    const conversation = shoppingEnsureSession();
    return conversation ? `&chat_session_id=${encodeURIComponent(conversation)}` : '';
  },
  body() {
    // The location verified once at sign-in (location.js) goes with the
    // session - in the body, never the URL - for spoken "nearest pharmacy" answers.
    const place = locationTurnContext();
    return place?.lat != null ? {location: {lat: place.lat, lng: place.lng}} : {};
  },
  onEvent: message => shoppingVoiceEvent(message),
  onUnreadable() { setVoiceStatus("Couldn't read Siru's reply. Refreshing the cart…"); shoppingRefresh(); },
  onReconnected: () => shoppingRefresh(),
  preview: text => shoppingLivePreview(text),
  previewText: () => shopEl.liveTranscript.textContent,
  notice: (text, kind) => shoppingNotice(text, kind),
  hasMute: true,
};

function voiceSurface() {
  return isMerchant() && typeof merchantVoiceSurface === 'object' ? merchantVoiceSurface : buyerVoiceSurface;
}
// The surface of the call in progress (a sign-in change ends it).
let voiceActiveSurface = buyerVoiceSurface;

el.micBtn.addEventListener("click", () => {
  if (voiceRoom) {
    stopVoiceSession();
  } else {
    startVoiceSession();
  }
});

el.muteBtn.addEventListener("click", async () => {
  if (!voiceRoom) return;
  el.muteBtn.disabled = true;
  try {
    micMuted = !micMuted;
    await voiceRoom.localParticipant.setMicrophoneEnabled(!micMuted);
    updateMuteUI();
    setVoiceStatus(micMuted ? "Mic off - waiting for reply" : "Listening - speak anytime");
  } catch (err) {
    micMuted = !micMuted; // revert - the toggle didn't actually take effect
    showToast({ icon: "alert", type: "info", body: "Couldn't switch the microphone. Check it is connected and allowed, then try again." });
  } finally {
    el.muteBtn.disabled = false;
  }
});

// Which of the requested filters the browser actually applied. They are
// requests, not guarantees: voiceIsolation is Chrome-only, and a browser may
// ignore any of them for a given device - shown so it is visible, not guessed.
const MIC_FILTERS = [
  ["echoCancellation", "EC"], ["noiseSuppression", "NS"],
  ["autoGainControl", "AGC"], ["voiceIsolation", "VI"],
];

function showMicFilters(room) {
  const box = el.micFilters;
  if (!box) return;
  const track = [...(room.localParticipant.audioTrackPublications?.values() || [])][0]?.track;
  const settings = track?.mediaStreamTrack?.getSettings?.() || {};
  box.replaceChildren();
  const applied = [];
  for (const [key, label] of MIC_FILTERS) {
    const on = settings[key] === true;
    // A filter the browser doesn't report at all is unknown, not off.
    const known = key in settings;
    const chip = document.createElement("span");
    chip.className = on ? "" : "off";
    chip.textContent = known ? `${label} ${on ? "on" : "off"}` : `${label} ?`;
    chip.title = known ? `${key}: ${on}` : `${key}: not reported by this browser`;
    box.append(chip);
    if (on) applied.push(key);
  }
  box.hidden = false;
  console.info("siru.mic_filters", {applied, settings});
}

function hideMicFilters() {
  if (el.micFilters) { el.micFilters.hidden = true; el.micFilters.replaceChildren(); }
}

function updateMuteUI() {
  el.muteBtn.setAttribute("aria-pressed", String(micMuted));
  iconSet(el.muteIcon, micMuted ? "mic-off" : "mic");
  el.muteLabel.textContent = micMuted ? "Mic off" : "Mic on";
}

// How long a voice call waits for the voice worker to join before saying it isn't running.
const VOICE_AGENT_JOIN_MS = 15000;
// One automatic retry in a new room when no assistant joined (startVoiceSession).
let voiceJoinRetried = false;

async function startVoiceSession() {
  const surface = voiceSurface();
  if (voiceRoom || surface.micBtn.disabled) return;
  const userId = getUserId();
  if (!userId) return;
  voiceActiveSurface = surface;
  const generationNow = surface.generation;
  const generation = generationNow();
  let connectingRoom = null;
  // Which part failed decides the message: the pharmacy API (voice token)
  // or the voice server (LiveKit) - a LiveKit "Failed to fetch" is not the API.
  let voiceStage = 'api';
  // A new call reports its own stage failures (shopping.js shoppingVoiceError).
  if (typeof voiceErrorShown === 'string') voiceErrorShown = '';

  surface.micBtn.disabled = true;
  setVoiceStatus("Connecting...");
  const voiceLog = (stage, detail = {}) => console.info(`siru: voice ${stage}`, detail);
  voiceLog('start');

  try {
    await surface.ready();
    if (generation !== generationNow()) return;
    // Do not send shopping_session_id: that selects the separate demo parser
    // in the worker and bypasses the Supervisor/Commerce/Care flow.
    const sessionQuery = surface.sessionQuery();
    voiceLog('token requested');
    // The microphone first: without it there is no call, so no voice session
    // (and no greeting) is started for nothing. The probe is released at once;
    // the call opens its own track after connecting.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({audio: true});
      probe.getTracks().forEach(track => track.stop());
    } catch (err) {
      voiceStage = 'microphone';
      throw err;
    }
    if (generation !== generationNow() || getUserId() !== userId) return;
    const voiceBody = surface.body();
    const { token, url, room_name: roomName } = await apiFetch(`/v1/voice/token?user_id=${encodeURIComponent(userId)}${sessionQuery}`, { method: "POST", body: JSON.stringify(voiceBody) });
    voiceLog('token issued', {room: roomName, server: new URL(url).host});
    if (generation !== generationNow() || getUserId() !== userId) return;

    // Browser-side cleanup before audio ever reaches STT: echo cancellation
    // keeps the assistant's own voice (from speakers) from being heard as the
    // user interrupting, and noise suppression / auto gain damp background
    // noise and far-away speakers. voiceIsolation is used where supported.
    const micCapture = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
      channelCount: 1,
    };
    // No Opus DTX: through a silent stretch (a muted mic, or noise
    // suppression giving exact silence) DTX sends next to nothing, LiveKit
    // reports this participant's connection as lost, and after 10 s the
    // client reconnects in full - the call dropped after ~20 s of quiet.
    const room = new LivekitClient.Room({ audioCaptureDefaults: micCapture, publishDefaults: { dtx: false } });
    connectingRoom = room;
    // The chat comes from the worker's turn messages: the text a turn answered,
    // the reply actually spoken, and that turn's cards - together, by turn id.
    room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      if (room !== voiceRoom || getUserId() !== userId || topic !== TURN_TOPIC) return;
      try {
        surface.onEvent(JSON.parse(new TextDecoder().decode(payload)));
      } catch (err) {
        surface.onUnreadable();
      }
    });
    // The live transcripts are not chat messages: the user's speech is shown
    // as it is heard, above the input, and Siru's only sets the status.
    // (Siru's transcript only says it is final when its stream closes, and
    // arrives when the speech ends - the turn messages above don't wait.)
    const transcript = (segment, identity) => {
      if (room !== voiceRoom || generation !== generationNow() || !segment.text?.trim()) return;
      if (identity === userId) {
        surface.preview(segment.text);
        setVoiceStatus(segment.final ? 'Processing...' : 'Listening...');
        // Speech the worker ignored (background, a filler word) starts no turn:
        // don't leave it showing.
        if (segment.final) setTimeout(() => {
          if (surface.previewText() === segment.text) surface.preview('');
        }, 6000);
      } else {
        // The assistant's own state: its transcript's last segment arrives
        // as the speech ends - after it is listening again - and "speaking"
        // then stayed for the rest of the call.
        const state = room.remoteParticipants.get(identity)?.attributes?.['lk.agent.state'];
        showAgentState(state || 'speaking');
      }
    };
    // The agent publishes every transcript twice - as an lk.transcription text
    // stream and as a legacy transcription event, each with its own segment id.
    // Use the text stream; the legacy event only for an older livekit-client.
    if (room.registerTextStreamHandler) {
      room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
        try {
          const attributes = reader.info.attributes || {};
          let text = '';
          if (reader[Symbol.asyncIterator]) {
            // Read as it arrives, so the preview and status follow the speech.
            for await (const chunk of reader) {
              text += chunk;
              transcript({id: attributes['lk.segment_id'] || reader.info.id, text, final: false}, participant.identity);
            }
          } else {
            text = await reader.readAll();
          }
          transcript({id: attributes['lk.segment_id'] || reader.info.id, text,
            final: String(attributes['lk.transcription_final']) === 'true'}, participant.identity);
        } catch {
          if (room === voiceRoom) setVoiceStatus('Transcript unavailable. Try reconnecting the mic.');
        }
      });
    } else {
      room.on(LivekitClient.RoomEvent.TranscriptionReceived, (segments, participant) => {
        if (room !== voiceRoom || getUserId() !== userId || !participant) return;
        for (const segment of segments) {
          transcript(segment, participant.identity);
        }
      });
    }
    // The voice worker's own state (LiveKit agents publish it as the
    // participant attribute lk.agent.state): back to "Listening" as soon as it
    // has finished speaking - its audio track never "ends", so without this
    // the status stayed "speaking" until the user spoke again.
    const showAgentState = (state) => {
      if (state === 'speaking') setVoiceStatus('SIRU AI is speaking...');
      else if (state === 'thinking') setVoiceStatus('Processing...');
      else if (state === 'listening') setVoiceStatus(micMuted ? "Mic off - waiting for reply" : "Listening - speak anytime");
    };
    room.on(LivekitClient.RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (room !== voiceRoom || !participant || participant.identity === userId) return;
      showAgentState(changed?.['lk.agent.state']);
    });
    // The voice worker joins the room on its own; if none does, say so rather
    // than listening to nobody.
    let agentJoined = false;
    let micLive = false;
    room.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
      agentJoined = true;
      voiceLog('assistant joined', {identity: participant.identity});
      voiceJoinRetried = false;
      // Until the voice worker has joined, nothing the user says is heard.
      if (micLive && room === voiceRoom && !micMuted) setVoiceStatus("Listening - speak anytime");
    });
    // The voice worker left (its session ended - e.g. speech recognition or
    // synthesis failed for good): end the call rather than stay connected to
    // nobody, keeping the failure the worker reported on screen.
    const assistantLeft = () => {
      const reported = typeof voiceErrorShown === 'string' ? voiceErrorShown : '';
      stopVoiceSession();
      setVoiceStatus(reported || 'The voice assistant left the call. Tap the mic to start again.');
    };
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      if (room !== voiceRoom || room.remoteParticipants.size > 0) return;
      // A full reconnect (a network drop) takes the assistant off this side
      // for a moment - before the room even says it is reconnecting - while
      // it stays in the call. Ending the call here aborted that reconnect.
      // Looked at again shortly; while reconnecting, Reconnected decides.
      voiceLog('assistant out of view', {identity: participant.identity});
      setTimeout(() => {
        if (room !== voiceRoom || room.remoteParticipants.size > 0) return;
        if (room.state !== LivekitClient.ConnectionState.Connected) return;
        voiceLog('assistant left', {identity: participant.identity});
        assistantLeft();
      }, ASSISTANT_LEFT_CHECK_MS);
    });
    room.on(LivekitClient.RoomEvent.Reconnected, () => {
      if (room !== voiceRoom) return;
      surface.onReconnected();
      setTimeout(() => {
        if (room !== voiceRoom || room.remoteParticipants.size > 0) return;
        voiceLog('assistant not back after reconnecting');
        assistantLeft();
      }, ASSISTANT_REJOIN_MS);
    });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      // Ignore events from a room we've already abandoned (e.g. mic
      // permission was denied and startVoiceSession's catch block already
      // disconnected it) - a track can still arrive and fire this after
      // disconnect() is called but before it's taken full effect, which
      // would otherwise stomp the UI back into a "connected" look.
      if (room !== voiceRoom) return;
      // The voice agent's spoken reply arrives as a remote audio track -
      // attach() returns a ready-to-play <audio> element.
      if (track.kind === LivekitClient.Track.Kind.Audio) {
        voiceLog('audio track subscribed');
        const el_ = track.attach();
        el_.addEventListener('playing', () => voiceLog('playback started'), {once: true});
        el_.dataset.voiceTrack = "true";
        document.body.appendChild(el_);
        // The assistant's own state, not "speaking": the track is subscribed
        // again after a reconnect while it is listening, and a live track
        // never ends - the status stayed "speaking" for the rest of the call.
        showAgentState(participant?.attributes?.['lk.agent.state'] || 'listening');
      }
    });
    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el_) => el_.remove());
    });
    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      if (room !== voiceRoom) return; // an abandoned room's own cleanup, not the active session
      voiceRoom = null;
      resetVoiceUI();
      setVoiceStatus('Voice disconnected. Tap the mic to reconnect.');
    });

    // Subscribe handlers can fire during connect (including the greeting).
    // Make this the active room before awaiting so those events aren't lost.
    voiceRoom = room;
    window.speechSynthesis?.cancel();
    voiceStage = 'livekit';
    voiceLog('livekit connect');
    await room.connect(url, token);
    voiceLog('room connected');
    voiceStage = 'media';
    if (generation !== generationNow()) {
      await room.disconnect();
      return;
    }
    if (typeof room.startAudio === "function") await room.startAudio();
    if (room !== voiceRoom || generation !== generationNow()) return;
    voiceStage = 'microphone';
    await room.localParticipant.setMicrophoneEnabled(true, micCapture);
    voiceLog('microphone on');
    if (room !== voiceRoom || generation !== generationNow()) { await room.disconnect(); return; }
    agentJoined = agentJoined || room.remoteParticipants.size > 0;
    setTimeout(async () => {
      if (room !== voiceRoom || agentJoined || room.remoteParticipants.size > 0) return;
      // LiveKit dispatches a room's assistant once and never again: when no
      // worker took it (none running, or LiveKit refused one that reported
      // itself busy - "no servers available") the room stays without one.
      // A new room is a new dispatch - once.
      if (!voiceJoinRetried) {
        voiceJoinRetried = true;
        voiceLog('assistant not joined - retrying once in a new room');
        await stopVoiceSession();
        if (generation === generationNow() && getUserId() === userId) {
          setVoiceStatus("Connecting to Siru...");
          await startVoiceSession();
        }
        return;
      }
      voiceJoinRetried = false;
      voiceLog('failed', {stage: 'assistant', reason: 'no voice worker joined'});
      const message = "The voice assistant didn't join the call - the voice worker isn't running. Typed chat still works.";
      setVoiceStatus(message);
      surface.notice(message, 'voice');
    }, VOICE_AGENT_JOIN_MS);
    micMuted = false;
    showMicFilters(room);

    surface.micBtn.setAttribute("aria-pressed", "true");
    surface.micBtn.classList.add("recording");
    surface.micLabel.textContent = "Stop talking";
    if (surface.hasMute) {
      el.muteBtn.hidden = false;
      updateMuteUI();
    }
    micLive = true;
    agentJoined = agentJoined || room.remoteParticipants.size > 0;
    // The assistant joins the room on its own (its process may still be
    // starting): "listening" only once it is there - before, speech is lost.
    setVoiceStatus(agentJoined ? "Listening - speak anytime" : "Connecting to Siru...");
  } catch (err) {
    // Clear voiceRoom (so the TrackSubscribed/Disconnected guards above
    // take effect) BEFORE awaiting disconnect(), not after - teardown can
    // take over a second, and any event that fires during that window
    // would otherwise still see voiceRoom pointing at this abandoned room
    // and wrongly treat it as the active session.
    const abandonedRoom = connectingRoom;
    if (voiceRoom === abandonedRoom) voiceRoom = null;
    if (abandonedRoom) {
      await abandonedRoom.disconnect();
    }
    if (generation !== generationNow() || getUserId() !== userId) return;
    resetVoiceUI();
    const message = err.name === 'NotAllowedError'
      ? 'Microphone permission denied. Allow microphone access in the browser and try again.'
      : voiceStage === 'api' && err.status === 503
        // The token route says what is missing (not configured / LiveKit unreachable) - no secrets.
        ? `Voice is unavailable: ${String(err.message || '').replace(/^\d{3}\s*/, '')}`
        : voiceStage === 'api' && !err.status && err.name === 'TypeError'
          // fetch itself failed: no answer the page could read (offline, the
          // server down or restarting, or a response the browser blocked).
          ? "Voice is unavailable: couldn't reach the Siru server. Check your connection and try again."
        : voiceStage === 'api' && err.status >= 500
          ? `Voice is unavailable: the server had a problem starting the call${err.requestId ? ` (ref ${err.requestId})` : ''}. Please try again.`
        : voiceStage === 'api'
          ? `Voice is unavailable right now. ${pharmacyError(err)}`
          : voiceStage === 'livekit'
            ? "Couldn't connect to the voice server (LiveKit). Check that it is running and reachable, then try again."
            : voiceStage === 'microphone'
              ? "Couldn't start the microphone. Check it is connected and not used by another app."
              : 'Voice is temporarily unavailable. Please try again.';
    // The technical reason (signalling, ICE, media) for whoever debugs it - not the user.
    console.warn('siru: voice failed', {stage: voiceStage, status: err.status || null, name: err.name, message: err.message,
      request_id: err.requestId || null});
    setVoiceStatus(message);
    surface.notice(message, 'voice');
    showToast({ icon: "alert", type: "info", body: escapeHtml(message) });
  } finally {
    if (generation === generationNow()) surface.micBtn.disabled = !getUserId();
  }
}

async function stopVoiceSession() {
  const room = voiceRoom;
  voiceRoom = null;
  resetVoiceUI();
  voiceActiveSurface.micBtn.disabled = !getUserId();
  if (room) await room.disconnect();
}

// A voice call is measured from the location it started with (sent once, with
// the session): a new location ends it, said - rather than answering "nearest"
// from the old place. Tapping the mic again starts one from the new place.
let voiceLocationKey = null;
locationSubscribe(({place}) => {
  const key = place ? `${place.source}:${place.lat}:${place.lng}` : '';
  const changed = voiceLocationKey !== null && key !== voiceLocationKey;
  voiceLocationKey = key;
  if (!changed || !voiceRoom) return;
  stopVoiceSession().then(() => {
    if (getUserId()) setVoiceStatus('Your delivery location changed. Tap the mic to talk from the new location.');
  });
});

function resetVoiceUI() {
  document.querySelectorAll("audio[data-voice-track]").forEach((el_) => el_.remove());
  for (const surface of [buyerVoiceSurface, typeof merchantVoiceSurface === 'object' ? merchantVoiceSurface : null]) {
    if (!surface) continue;
    surface.preview('');
    surface.micBtn.setAttribute("aria-pressed", "false");
    surface.micBtn.classList.remove("recording");
    iconSet(surface.micIcon, "mic");
    surface.micLabel.textContent = "Start talking";
  }
  el.muteBtn.hidden = true;
  hideMicFilters();
  micMuted = false;
  setVoiceStatus("");
}

// The call's status line: the pharmacy chat's, or the merchant assistant's.
function setVoiceStatus(text) {
  // During a call, that call's chat; otherwise the signed-in role's.
  const surface = voiceRoom ? voiceActiveSurface : voiceSurface();
  if (surface.setStatus) {
    surface.setStatus(text);
    return;
  }
  el.voiceStatus.textContent = text;
  if (typeof shoppingStatus === 'function') shoppingStatus();
}

// ---------- Demo purchase (not a real order - see backend docstring) -------

async function purchaseProduct(btn) {
  const productId = btn.getAttribute("data-product-id");
  const userId = getUserId();
  btn.disabled = true;
  btn.textContent = "Processing...";

  try {
    const data = await apiFetch(`/v1/catalog/products/${encodeURIComponent(productId)}/demo-purchase?user_id=${encodeURIComponent(userId)}`, {
      method: "POST",
    });
    btn.textContent = "Purchased";

    const related = data.related_products || [];
    let body = `<strong>Purchased ${escapeHtml(data.product_name)}!</strong>`;
    if (related.length) {
      const names = related.map((p) => `${escapeHtml(p.name)} ($${Number(p.price).toFixed(2)})`).join(", ");
      body += `<br>You might also like: ${names}`;
    }
    showToast({ icon: "check", type: "success", body });

    // The purchase stops the abandoned-search reminder for this item
    // server-side - refresh so the list reflects that right away.
    refreshNotifications();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Buy (demo)";
    showToast({ icon: "alert", type: "info", body: `Purchase failed. ${escapeHtml(pharmacyError(err))}` });
  }
}

// ---------- Notifications ----------

el.notifBell.addEventListener("click", () => {
  el.notifPanel.hidden = !el.notifPanel.hidden;
  if (!el.notifPanel.hidden) refreshNotifications();
});

el.checkNowBtn.addEventListener("click", () => {
  checkAbandonedSearchesThenRefresh();
  resetPollCountdown();
});

// The periodic poll and "Check now": re-read this user's notifications. The
// matching jobs that create them (/v1/notifications/check-*) are the
// operator's scheduled jobs, behind SERVICE_API_KEY - never a browser's call.
async function checkAbandonedSearchesThenRefresh() {
  if (!getUserId() || isMerchant()) return;
  refreshNotifications();
}

async function refreshNotifications() {
  const userId = getUserId();
  if (isMerchant()) return;  // buyer notifications (refills, back in stock)
  if (!userId) {
    el.notifList.innerHTML = `<p class="muted">Enter a user above to see notifications.</p>`;
    setNotifCount(0);
    return;
  }

  try {
    const items = await apiFetch(`/v1/notifications/${encodeURIComponent(userId)}?domain=${DOMAIN}`);
    if (getUserId() !== userId) return;
    renderNotifications(items);
  } catch (err) {
    if (getUserId() === userId) el.notifList.innerHTML = `<p class="muted">Couldn't load notifications. ${escapeHtml(pharmacyError(err))}</p>`;
  }
}

const STATUS_META = {
  notified: { icon: "check", label: "Notified" },
  watching: { icon: "info", label: "Watching" },
  purchased: { icon: "check", label: "Purchased" },
};

function renderNotifications(items) {
  const notifiedIds = new Set(items.filter((i) => i.status === "notified").map((i) => i.id));

  if (knownNotifiedIds === null) {
    // First load for this user - this is the existing baseline, not new
    // events, so seed silently without popping any toasts.
    knownNotifiedIds = notifiedIds;
  } else {
    for (const item of items) {
      if (item.status === "notified" && !knownNotifiedIds.has(item.id)) {
        toastForNewlyNotified(item);
      }
    }
    knownNotifiedIds = notifiedIds;
  }

  if (!items.length) {
    el.notifList.innerHTML = `<p class="muted">Nothing yet - search for a product to start watching it.</p>`;
    setNotifCount(0);
    return;
  }

  const sorted = [...items].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  setNotifCount(notifiedIds.size);

  el.notifList.innerHTML = sorted
    .map((item) => {
      const meta = STATUS_META[item.status] || { icon: "info", label: String(item.status ?? "") };
      const when = new Date(item.created_at).toLocaleString();
      return `
        <div class="notif-item status-${escapeHtml(item.status)}">
          <span class="notif-icon" data-icon="${meta.icon}"></span>
          <div class="notif-body">
            <div class="notif-entity">${escapeHtml(item.entity || "item")}</div>
            <div class="notif-meta">${escapeHtml(meta.label)} - ${escapeHtml(item.intent)} - ${escapeHtml(when)}</div>
          </div>
        </div>`;
    })
    .join("");
  iconsHydrate(el.notifList);
}

function toastForNewlyNotified(item) {
  const entity = escapeHtml(item.entity || "an item");
  if (item.intent === "monitor_availability") {
    showToast({ icon: "check", type: "success", body: `Good news - <strong>${entity}</strong> is back in stock!` });
  } else if (item.intent === "viewed_no_purchase") {
    showToast({ icon: "bell", type: "info", body: `Still interested in <strong>${entity}</strong>? It's still available.` });
  } else if (item.intent === "refill_reminder") {
    showToast({ icon: "bell", type: "info", body: `Time to refill <strong>${entity}</strong> - it's been about a month!` });
  } else {
    showToast({ icon: "bell", type: "info", body: `Update on <strong>${entity}</strong>.` });
  }
}

function setNotifCount(count) {
  if (count > 0) {
    el.notifCount.hidden = false;
    el.notifCount.textContent = count > 9 ? "9+" : String(count);
  } else {
    el.notifCount.hidden = true;
  }
}

// ---------- 5-minute auto-poll ----------

function startPolling() {
  resetPollCountdown();
  setInterval(() => {
    secondsUntilNextPoll -= 1;
    if (secondsUntilNextPoll <= 0) {
      checkAbandonedSearchesThenRefresh();
      resetPollCountdown();
    } else {
      updatePollStatusLabel();
    }
  }, 1000);
}

function resetPollCountdown() {
  secondsUntilNextPoll = POLL_INTERVAL_MS / 1000;
  updatePollStatusLabel();
}

function updatePollStatusLabel() {
  const m = Math.floor(secondsUntilNextPoll / 60);
  const s = secondsUntilNextPoll % 60;
  el.pollStatus.textContent = `next auto-check in ${m}:${String(s).padStart(2, "0")}`;
}

// ---------- Demo panel: catalog + simulate restock ----------

async function loadProducts() {
  try {
    const products = await apiFetch(`/v1/catalog/products?domain=${DOMAIN}`);
    renderProducts(products);
  } catch (err) {
    el.productList.innerHTML = `<p class="muted">Couldn't load the catalog. ${escapeHtml(pharmacyError(err))}</p>`;
  }
}

function renderProducts(products) {
  if (!products.length) {
    el.productList.innerHTML = `<p class="muted">No products found.</p>`;
    return;
  }

  el.productList.innerHTML = products
    .map((p) => {
      const stockClass = p.in_stock ? "in" : "out";
      const stockLabel = p.in_stock ? "In stock" : "Out of stock";
      const priceLabel = p.price != null ? `$${Number(p.price).toFixed(2)}` : "";
      const actionHtml = p.in_stock
        ? ""
        : `<button data-product-id="${escapeHtml(p.id)}" data-product-name="${escapeHtml(p.name)}" class="restock-btn">Simulate restock</button>`;
      return `
        <div class="product-item" data-row-for="${escapeHtml(p.id)}">
          <div class="product-info">
            <div class="product-name">${escapeHtml(p.name)}</div>
            <div class="product-meta">${escapeHtml(p.category || "")} ${priceLabel}</div>
          </div>
          <span class="stock-pill ${stockClass}">${stockLabel}</span>
          ${actionHtml}
        </div>`;
    })
    .join("");

  el.productList.querySelectorAll(".restock-btn").forEach((btn) => {
    btn.addEventListener("click", () => simulateRestock(btn));
  });
}

async function simulateRestock(btn) {
  const productId = btn.getAttribute("data-product-id");
  const productName = btn.getAttribute("data-product-name");
  btn.disabled = true;
  btn.textContent = "Restocking...";

  try {
    const data = await apiFetch(`/v1/catalog/products/${encodeURIComponent(productId)}/restock`, { method: "POST" });
    const row = el.productList.querySelector(`[data-row-for="${CSS.escape(productId)}"]`);
    if (row) {
      const notifiedCount = (data.notified_user_ids || []).length;
      row.innerHTML = `
        <div class="product-info">
          <div class="product-name">${escapeHtml(productName)}</div>
          <div class="restock-note">Restocked - ${notifiedCount} watcher${notifiedCount === 1 ? "" : "s"} notified</div>
        </div>
        <span class="stock-pill in">In stock</span>`;
    }
    // If the current user was one of the watchers, this shows up immediately.
    refreshNotifications();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Simulate restock";
    alert(`Restock failed. ${pharmacyError(err)}`);
  }
}

// ---------- Toasts ----------

const TOAST_LIFETIME_MS = 8000;

function showToast({ icon = "bell", type = "info", body }) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon" data-icon="${icon}"></span>
    <div class="toast-body">${body}</div>
    <button class="toast-close" aria-label="Dismiss"><span class="icon" data-icon="x"></span></button>`;
  iconsHydrate(toast);

  const remove = () => {
    toast.classList.add("toast-leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };
  toast.querySelector(".toast-close").addEventListener("click", remove);
  setTimeout(remove, TOAST_LIFETIME_MS);

  el.toastContainer.appendChild(toast);
}

// ---------- utils ----------

// escapeHtml / safeImageUrl: safe-dom.js (loaded before this file).

// ---------- init ----------

el.apiBaseLabel.textContent = API_BASE;
// A signed-in buyer's notifications and contact are loaded by
// applySignedInUser (user-menu.js), once the server has confirmed the role.
startPolling();
