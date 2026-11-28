// What the app has learned about particular files, by file name (lib/sourcesubs.js fileIdent):
//   - its track list, read through the PC server for the source list's built-in subtitle marks;
//   - which add-on subtitles keep time with it (lib/synccheck.js), found while it played or by
//     the sync test run from the source list.
// Oldest entries go first once there are too many (insertion order).
import * as store from './store.js';

const SYNC = 'subSync';
const TRACKS = 'srcTracks';
const MAX_SYNC = 100;
const MAX_TRACKS = 300;

// Read from storage once per profile: the source list looks up every source on screen.
let cache = {};

function all(name) {
  const k = store.activeProfile().id + '|' + name;
  if (!cache[k]) cache[k] = store.get(name, {}) || {};
  return cache[k];
}

function put(name, id, value, max) {
  const every = all(name);
  delete every[id];
  every[id] = value;
  const keys = Object.keys(every);
  for (let i = 0; i < keys.length - max; i++) delete every[keys[i]];
  store.set(name, every);
}

// { subtitle key: { state, shift, conf, lang } } for this file.
export function seenSync(id) {
  return Object.assign({}, (id && all(SYNC)[id]) || {});
}

// v: { state, shift, conf }; lang: the subtitle's language (canonical). "Unsure" isn't kept: the
// next viewing tries again.
export function rememberSync(id, key, v, lang) {
  if (!id || v.state === 'unsure') return;
  const mine = Object.assign({}, all(SYNC)[id] || {});
  mine[key] = { state: v.state, shift: v.shift, conf: typeof v.conf === 'number' ? v.conf : null, lang: lang || '' };
  put(SYNC, id, mine, MAX_SYNC);
}

// The compact track list (lib/sourcesubs.js compact()) or null.
export function knownTracks(id) {
  return (id && all(TRACKS)[id]) || null;
}

export function rememberTracks(id, compactTracks) {
  if (id) put(TRACKS, id, compactTracks, MAX_TRACKS);
}
