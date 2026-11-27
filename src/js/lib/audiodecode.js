// Turns a short piece of AAC sound (as the PC's Stremio server hands it out) into samples, with the
// browser's own audio decoder. Nothing is played: the samples only feed lib/soundsample.js.
// Whether a TV's web engine can do this is not known until it is tried; status() says how it went
// (shown in Settings → Playback diagnostics).

const RATES = [8000, 16000, 22050, 44100, 48000]; // the lowest the engine accepts: less to chew on
const TIMEOUT_MS = 15000;

let ctx = null;
let state = 'not tried'; // 'not tried' | 'no decoder' | 'ok' | 'failed: ...'

function context() {
  if (ctx) return ctx;
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) return null;
  for (let i = 0; i < RATES.length && !ctx; i++) {
    try {
      ctx = new Ctor(2, RATES[i], RATES[i]);
    } catch (e) {
      /* this rate is not offered */
    }
  }
  return ctx;
}

// The engine has an audio decoder a page may call (it may still refuse the format).
export function supported() {
  if (context()) return true;
  state = 'no decoder';
  return false;
}

export function status() {
  return state;
}

// bytes: a whole little MP4 file (header + one piece). Resolves { left, right, rate }.
export function decode(bytes) {
  return new Promise((resolve, reject) => {
    const c = context();
    if (!c) {
      state = 'no decoder';
      return reject(new Error(state));
    }
    let settled = false;
    const no = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (state !== 'ok') state = 'failed: ' + ((e && (e.name || e.message)) || 'the engine refused the sound');
      reject(new Error(state));
    };
    const timer = setTimeout(() => no({ message: 'no answer' }), TIMEOUT_MS);
    const yes = (buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!buf || !buf.length) {
        settled = false;
        return no({ message: 'empty' });
      }
      state = 'ok';
      resolve({ left: buf.getChannelData(0), right: buf.numberOfChannels > 1 ? buf.getChannelData(1) : null, rate: buf.sampleRate });
    };
    try {
      // The older form with callbacks: engines that return a promise call them as well.
      const p = c.decodeAudioData(bytes, yes, no);
      if (p && p.catch) p.catch(no);
    } catch (e) {
      no(e);
    }
  });
}
