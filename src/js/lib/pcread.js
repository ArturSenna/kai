// The two ways the app has the PC's Stremio server read part of a file for it, wired to the network:
//   - a built-in subtitle track as text (lib/embedsubs.js);
//   - a stretch of the sound, for the subtitle sync test (lib/soundsample.js).
// Shared by the player and by the sync test run from the source list before a video plays.
// mediaUrl is the address the TV plays (a debrid link, or the server's own for a torrent).
import * as server from '../api/server.js';
import * as relay from './relay.js';
import { getText, getBuffer } from './http.js';
import * as subs from './subs.js';
import * as embedsubs from './embedsubs.js';
import * as soundsample from './soundsample.js';
import * as audiodecode from './audiodecode.js';

function newSession() {
  return 'kai' + Math.random().toString(36).slice(2);
}

// Built-in subtitle track `index` (its place among the file's text tracks).
export function subtitleTrack(mediaUrl, index, onChange, onFail) {
  const base = server.baseUrl() + 'hlsv2/';
  const query = '?mediaURL=' + encodeURIComponent(mediaUrl);
  return embedsubs.Loader({
    newSession: newSession,
    blockUrl: (sid, k) => relay.through(base + sid + '/subtitle' + index + '/segment' + k + '.vtt' + query, 45000),
    stopUrl: (sid) => relay.through(base + sid + '/destroy', 8000),
    getText: (url) => getText(url, { timeout: 45000, quiet: true }),
    parse: subs.parse,
    onChange: onChange,
    onFail: onFail,
  });
}

// `seconds` of audio track `audio` (its place among the file's audio tracks) from `from` on, or
// null when this device can't decode the server's sound.
export function sound(mediaUrl, audio, from, seconds, onDone, onFail) {
  if (!audiodecode.supported()) return null;
  const base = server.baseUrl() + 'hlsv2/';
  const query = '?mediaURL=' + encodeURIComponent(mediaUrl) + '&audioCodecs=aac&maxAudioChannels=2';
  return soundsample.Sampler({
    from: from,
    seconds: seconds,
    newSession: newSession,
    listUrl: (sid) => relay.through(base + sid + '/audio' + audio + '.m3u8' + query, 30000),
    fileUrl: (sid, uri) => relay.through(base + sid + '/' + uri, 45000),
    stopUrl: (sid) => relay.through(base + sid + '/destroy', 8000),
    getText: (url) => getText(url, { timeout: 30000, quiet: true }),
    getBytes: (url) => getBuffer(url, { timeout: 45000, quiet: true }),
    decode: audiodecode.decode,
    onDone: onDone,
    onFail: onFail,
  });
}
