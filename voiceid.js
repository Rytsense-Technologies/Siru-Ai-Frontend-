// Voice ID: the user records a few seconds of their own voice, and from then
// on only that voice reaches Sarvam STT (multi_agent_framework/voice/audio_gate.py).
//
// The recording is sent once as raw 16-bit mono PCM at 16 kHz, turned into a
// voiceprint on the server and discarded. Nothing is stored in the browser,
// and the voiceprint can be deleted here at any time - deleting it makes Siru
// accept every speaker again, it never locks the user out.
const voiceIdEl = Object.fromEntries([
  "voiceIdStatus", "voiceIdEnrol", "voiceIdDelete", "voiceIdMeter", "voiceIdNote",
].map(id => [id, document.getElementById(id)]));

const VOICE_ID_SAMPLE_RATE = 16000;
let voiceIdRecording = false;

function voiceIdShow(profile) {
  const enrolled = Boolean(profile?.enrolled);
  voiceIdEl.voiceIdStatus.textContent = enrolled
    ? `Enrolled · ${profile.samples} recording${profile.samples === 1 ? '' : 's'}`
    : 'Not enrolled';
  voiceIdEl.voiceIdStatus.className = `voiceid-status ${enrolled ? 'on' : 'off'}`;
  voiceIdEl.voiceIdDelete.hidden = !enrolled;
  voiceIdEl.voiceIdEnrol.textContent = enrolled ? 'Add another recording' : 'Record my voice';
  voiceIdEl.voiceIdNote.textContent = enrolled
    ? 'Only your voice is sent to speech recognition. Other voices nearby are dropped before transcription.'
    : `Record about ${Math.round(profile?.required_seconds || 6)} seconds so Siru can tell your voice from other people in the room.`;
}

async function voiceIdRefresh() {
  if (!getUserId()) { voiceIdShow(null); return; }
  try {
    voiceIdShow(await pharmacyApi.voiceProfile());
  } catch (error) {
    voiceIdEl.voiceIdStatus.textContent = error.status === 404 ? 'Needs a newer pharmacy API' : 'Status unavailable';
    voiceIdEl.voiceIdStatus.className = 'voiceid-status off';
  }
}

// Records `seconds` of microphone audio as 16 kHz mono PCM16.
async function voiceIdRecord(seconds, onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({audio: {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
  }});
  const context = new (window.AudioContext || window.webkitAudioContext)({sampleRate: VOICE_ID_SAMPLE_RATE});
  try {
    const source = context.createMediaStreamSource(stream);
    const node = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let samples = 0;
    const wanted = seconds * context.sampleRate;
    await new Promise(resolve => {
      node.onaudioprocess = event => {
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        let peak = 0;
        for (let i = 0; i < input.length; i++) {
          const clamped = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
          peak = Math.max(peak, Math.abs(clamped));
        }
        chunks.push(pcm);
        samples += pcm.length;
        onLevel?.(peak, Math.min(1, samples / wanted));
        if (samples >= wanted) resolve();
      };
      source.connect(node);
      node.connect(context.destination);
    });
    node.onaudioprocess = null;
    node.disconnect();
    source.disconnect();
    const all = new Int16Array(samples);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    return {pcm: all.buffer, sampleRate: context.sampleRate};
  } finally {
    stream.getTracks().forEach(track => track.stop());
    context.close();
  }
}

voiceIdEl.voiceIdEnrol.onclick = async () => {
  if (voiceIdRecording || !getUserId()) return;
  voiceIdRecording = true;
  voiceIdEl.voiceIdEnrol.disabled = true;
  voiceIdEl.voiceIdMeter.hidden = false;
  const profile = await pharmacyApi.voiceProfile().catch(() => null);
  const seconds = Math.round(profile?.required_seconds || 6);
  try {
    voiceIdEl.voiceIdNote.textContent = `Speak normally for ${seconds} seconds — say what you would ask Siru.`;
    const {pcm, sampleRate} = await voiceIdRecord(seconds, (peak, done) => {
      voiceIdEl.voiceIdMeter.value = done;
      voiceIdEl.voiceIdStatus.textContent = peak > 0.02 ? 'Listening…' : 'Speak a little louder…';
    });
    voiceIdEl.voiceIdStatus.textContent = 'Saving…';
    voiceIdShow(await pharmacyApi.enrolVoice(pcm, sampleRate));
  } catch (error) {
    voiceIdEl.voiceIdStatus.textContent = 'Not enrolled';
    voiceIdEl.voiceIdStatus.className = 'voiceid-status off';
    voiceIdEl.voiceIdNote.textContent = error?.name === 'NotAllowedError'
      ? 'Microphone access is needed to record your voice.'
      : (error?.message || 'That recording could not be used. Please try again.');
  } finally {
    voiceIdEl.voiceIdMeter.hidden = true;
    voiceIdEl.voiceIdMeter.value = 0;
    voiceIdEl.voiceIdEnrol.disabled = false;
    voiceIdRecording = false;
  }
};

voiceIdEl.voiceIdDelete.onclick = async () => {
  voiceIdEl.voiceIdDelete.disabled = true;
  try {
    voiceIdShow(await pharmacyApi.deleteVoiceProfile());
    voiceIdEl.voiceIdNote.textContent = 'Voiceprint deleted. Siru now accepts any voice again.';
  } catch (error) {
    voiceIdEl.voiceIdNote.textContent = "Couldn't delete that just now.";
  } finally {
    voiceIdEl.voiceIdDelete.disabled = false;
  }
};
