// The PC's Stremio server only answers web pages on its own list (strem.io sites, itself). The app's
// page under TizenBrew (http://127.0.0.1:8081) is not on it, so the TV's browser hides the server's
// answers from the app: "no response", though the server is fine. The app's helper service on the
// TV (service/remote-service.js, the phone remote) is not a web page, so it asks the server for us.
// Only what the app reads itself goes this way (settings, track lists, subtitle text); the video
// still plays straight from the PC.
import { getJSON } from './http.js';
import { isTizen } from './platform.js';

const HELPER = 'http://127.0.0.1:8095'; // the helper's address, as in lib/phone.js
// The helper exists under TizenBrew, and on the development PC when started by hand.
const ENABLED = isTizen() || window.location.hostname === 'localhost';
const ASK_AGAIN_MS = 10000;
const HOME = /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

let state = { ok: false, ip: '', at: 0 };
let pending = null;

// Resolves true once the helper is there and can relay. A "no" is asked again after a while:
// the helper starts a moment after the app, and an older helper is replaced when the TV restarts.
export function ready() {
  if (!ENABLED) return Promise.resolve(false);
  if (state.ok || Date.now() - state.at < ASK_AGAIN_MS) return Promise.resolve(state.ok);
  if (!pending) {
    pending = getJSON(HELPER + '/api/info', { timeout: 2500, quiet: true })
      .then(
        (info) => (state = { ok: !!(info && info.relay), ip: (info && info.ip) || '', at: Date.now() }),
        () => (state = { ok: false, ip: '', at: Date.now() })
      )
      .then(() => {
        pending = null;
        return state.ok;
      });
  }
  return pending;
}

// The helper is expected here but isn't relaying (not running, or an older copy still loaded).
export function missing() {
  return ENABLED && !state.ok;
}

// This TV's address on the home network, as the helper sees it ('' when unknown).
export function tvIp() {
  return state.ip;
}

// The address to ask instead of `url`: through the helper when it relays and `url` is on the home
// network, else `url` itself. timeoutMs: how long the caller will wait.
export function through(url, timeoutMs) {
  if (!state.ok || !HOME.test(url)) return url;
  return HELPER + '/api/relay?t=' + (timeoutMs || 20000) + '&u=' + encodeURIComponent(url);
}
