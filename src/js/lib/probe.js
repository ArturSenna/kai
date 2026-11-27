// What this TV's web engine exposes, to decide how embedded audio/subtitle tracks can be reached
// (Settings → Playback diagnostics, and the remote log). Read-only: it changes nothing in playback.
import { log } from './log.js';
import * as asscanvas from './asscanvas.js';

// Rows are { label, sub } so they fit a menu line on the TV (long lines are cut off there).
let lastMedia = null; // rows about the last video played
let lastStream = null; // rows about how its stream held up (stalls, reconnects), kept by the player

function yn(x) {
  return x ? 'yes' : 'no';
}

export function environment() {
  const ua = navigator.userAgent || '';
  const chrome = (ua.match(/Chrom(?:e|ium)\/(\d+)/) || [])[1] || '?';
  let tizenVersion = '';
  try {
    tizenVersion = window.tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version');
  } catch (e) {
    /* not a Tizen app context */
  }
  let webgl2 = false;
  try {
    webgl2 = !!document.createElement('canvas').getContext('webgl2');
  } catch (e) {
    /* no WebGL2 */
  }
  const w = window.webapis;
  return [
    { label: 'Chromium ' + chrome + (tizenVersion ? ' · Tizen ' + tizenVersion : '') },
    { label: 'tizen: ' + yn(window.tizen) + ' · webapis: ' + yn(w) + ' · avplay: ' + yn(w && w.avplay) },
    { label: 'WebAssembly: ' + yn(typeof WebAssembly === 'object') + ' · WebGL2: ' + yn(webgl2), sub: 'OffscreenCanvas: ' + yn(typeof OffscreenCanvas === 'function') },
    { label: 'Styled ASS: ' + asscanvas.status() },
  ];
}

// Samsung's product APIs (webapis.avplay among them) come from a script the TV serves to packaged
// apps. Under TizenBrew the page is not packaged, so this asks for it and reports whether it came.
function loadWebapis() {
  if (window.webapis) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => resolve(!!window.webapis);
    const s = document.createElement('script');
    s.src = '$WEBAPIS/webapis/webapis.js';
    s.onload = s.onerror = done;
    setTimeout(done, 4000);
    document.head.appendChild(s);
  });
}

function trackRows(videoEl, name) {
  const tracks = videoEl[name];
  if (!tracks) return [{ label: name + ': not exposed' }];
  const out = [{ label: name + ': ' + tracks.length }];
  for (let i = 0; i < tracks.length && i < 12; i++) {
    const tr = tracks[i];
    const state = name === 'audioTracks' ? (tr.enabled ? 'on' : 'off') : tr.mode + (tr.cues ? ' · ' + tr.cues.length + ' cues' : '');
    out.push({ label: '#' + i + ' ' + ([tr.language, tr.label].filter(Boolean).join(' · ') || '(no language or title)'), sub: [tr.kind, state].filter(Boolean).join(' · ') });
  }
  return out;
}

// Called once a video has been playing for a few seconds (tracks appear after the start).
// Only the file extension is kept from the address: stream links carry account keys.
export function media(videoEl) {
  const ext = (String(videoEl.currentSrc || '').split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1] || '?';
  lastMedia = [{ label: 'video: ' + videoEl.videoWidth + 'x' + videoEl.videoHeight + ' · .' + ext }]
    .concat(trackRows(videoEl, 'audioTracks'))
    .concat(trackRows(videoEl, 'textTracks'));
  log.info(
    'Diagnóstico',
    environment()
      .concat(lastMedia)
      .map((r) => r.label + (r.sub ? ' (' + r.sub + ')' : ''))
      .join(' ; ')
  );
}

// The player's record of the last video's stream: how often it ran out of data and what was done.
export function stream(rows) {
  lastStream = rows;
}

// Rows for the Settings screen; media and stream are null until a video has played in this session.
export function report() {
  return loadWebapis().then(() => ({ environment: environment(), media: lastMedia, stream: lastStream }));
}
