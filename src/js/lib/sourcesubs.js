// Built-in subtitles of a title's sources, known before one is picked.
// The PC's Stremio server reads a file's track list (/tracks: ffprobe opens the start of the file,
// a few small reads). The source list asks it for a handful of sources in the background and
// marks those with a built-in subtitle in the viewer's first and second subtitle language.
// What can be asked about without side effects:
//   - a direct link (debrid or plain HTTP): the server reads a few hundred KB of it;
//   - not a torrent: asking would make the PC start downloading it;
//   - not a debrid link still marked "download": opening it adds the torrent to the debrid
//     account, and what plays meanwhile is a short placeholder clip with no tracks.
// Answers are remembered per file name (see fileIdent), so a source checked once is marked at once.
// Pure functions and a queue with no clock or network of its own, so it runs under `npm test`.
import { ofTrack } from './lang.js';
import { pickSub } from './trackselect.js';

// What tells one copy of a film from another: the file's name. (Never the whole address: stream
// links carry account keys.) '' when the source doesn't say.
export function fileIdent(stream, videoId) {
  const bh = (stream && stream.behaviorHints) || {};
  let name = bh.filename || bh.videoHash || '';
  if (!name && typeof stream.infoHash === 'string') name = stream.infoHash + ':' + stream.fileIdx;
  if (!name && typeof stream.url === 'string') {
    const last = stream.url.split(/[?#]/)[0].split('/').pop() || '';
    if (/\.(mkv|mp4|m4v|avi|ts|webm|mov)$/i.test(last)) name = last;
  }
  return name ? videoId + '|' + name : '';
}

// Uncached debrid sources, as the common add-ons mark them: "[RD download]", "⏳", "⬇".
const NOT_READY = /\bdownload\b|uncached|⏳|⬇/i;

// The PC may read this source's file to list its tracks.
export function canProbe(stream) {
  if (!stream || typeof stream.url !== 'string' || !/^https?:\/\//i.test(stream.url)) return false;
  if (stream.behaviorHints && stream.behaviorHints.proxyHeaders) return false;
  return !NOT_READY.test(String(stream.name || ''));
}

// The file's subtitle tracks the player can show as full dialogue: text (not pictures), not
// forced, not signs-and-songs. [{ index, lang, title }], index = place among its text tracks.
export function dialogueTracks(tracks) {
  const out = [];
  ((tracks && tracks.subs) || []).forEach((tr, i) => {
    const c = { source: 'embedded', index: i, lang: ofTrack(tr.lang, tr.label), title: tr.label || '', forced: !!tr.forced, bitmap: /PGS|VOBSUB|DVD/i.test(tr.codec || '') };
    if (pickSub([c], { langs: [c.lang] })) out.push({ index: i, lang: c.lang, title: c.title });
  });
  return out;
}

// Which of the wanted languages the file has as a built-in dialogue track.
// primary, secondary: canonical codes, most wanted first (['pt-br', 'pt'], ['en']).
// Returns { primary: code or '', secondary: code or '' }: the best match found in each.
export function langTags(tracks, primary, secondary) {
  const have = dialogueTracks(tracks).map((x) => x.lang);
  const best = (list) => (list || []).find((code) => have.indexOf(code) >= 0) || '';
  return { primary: best(primary), secondary: best(secondary) };
}

// A track list as remembered (the parts the source list needs) and back.
export function compact(tracks) {
  return {
    s: ((tracks && tracks.subs) || []).map((tr) => [tr.lang || '', tr.label || '', tr.codec || '']),
    a: ((tracks && tracks.audio) || []).map((tr) => [tr.lang || '', tr.label || '', tr.codec || '']),
  };
}

export function expand(c) {
  const one = (type) => (x) => ({ type: type, lang: x[0], label: x[1], codec: x[2] });
  return { subs: ((c && c.s) || []).map(one('text')), audio: ((c && c.a) || []).map(one('audio')) };
}

// Work done a few at a time, most wanted first.
// o.run(item) -> Promise; o.onDone(key, item, result, error); o.limit: how many at once (2)
// add(key, item, rank): queued once per key; a lower rank goes first, and adding again with a
// lower rank moves it up. Nothing new starts after stop().
export function Queue(o) {
  const limit = o.limit || 2;
  const waiting = {}; // key -> { item, rank }
  const seen = {}; // key -> true once queued
  let running = 0;
  let stopped = false;

  function pump() {
    while (!stopped && running < limit) {
      let next = null;
      Object.keys(waiting).forEach((k) => {
        if (!next || waiting[k].rank < waiting[next].rank) next = k;
      });
      if (next === null) return;
      const job = waiting[next];
      delete waiting[next];
      running++;
      const key = next;
      Promise.resolve()
        .then(() => o.run(job.item))
        .then(
          (res) => finish(key, job.item, res, null),
          (err) => finish(key, job.item, null, err || new Error('failed'))
        );
    }
  }

  function finish(key, item, res, err) {
    running--;
    if (!stopped) o.onDone(key, item, res, err);
    pump();
  }

  return {
    add: (key, item, rank) => {
      if (stopped) return;
      if (waiting[key]) {
        if (rank < waiting[key].rank) waiting[key].rank = rank;
        return;
      }
      if (seen[key]) return;
      seen[key] = true;
      waiting[key] = { item: item, rank: rank };
      pump();
    },
    has: (key) => !!seen[key],
    busy: () => running > 0 || Object.keys(waiting).length > 0,
    stop: () => {
      stopped = true;
    },
  };
}
