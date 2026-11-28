// The subtitle sync test run from the source list, before a video plays (the → key on a source).
// The same measuring as during playback (lib/synccheck.js), against the same references: a
// built-in text track of the file when it has one, else a few minutes of its sound, both read by
// the PC's Stremio server. Nothing else is using the line yet, so the PC reads straight away.
// No DOM and no network of its own (all passed in), so it runs under `npm test`.
import { Checker, TRACK_SPAN, MAX_CANDIDATES } from './synccheck.js';
import { dialogueTracks } from './sourcesubs.js';
import { pickAudio } from './trackselect.js';
import { canon, ofTrack } from './lang.js';

// Where in the film the stretch begins: a fifth of the way in (past the opening titles, where
// people talk), between 2 and 15 minutes in. runtime in seconds (0 when unknown).
export function startAt(runtime) {
  const at = (runtime > 0 ? runtime : 5400) * 0.2;
  return Math.round(Math.max(120, Math.min(900, at)) / 10) * 10;
}

// The add-on subtitles to test: those in the first group of languages that has any (first-choice
// languages, else second-choice ones), the most wanted language first, no more than are tested.
export function candidates(subs, groups) {
  for (let g = 0; g < groups.length; g++) {
    const list = (subs || [])
      .map((s, i) => ({ s: s, i: i, at: groups[g].indexOf(canon(s.lang)) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at || a.i - b.i)
      .map((x) => x.s);
    if (list.length) return list.slice(0, MAX_CANDIDATES);
  }
  return [];
}

// The audio track the player will start with (lib/trackselect.js), else the file's first.
export function soundTrack(tracks, audioLangs) {
  const list = ((tracks && tracks.audio) || []).map((tr) => ({ lang: ofTrack(tr.lang, tr.label), title: tr.label || '' }));
  const i = list.length > 1 ? pickAudio(list, audioLangs || []) : -1;
  return i >= 0 ? i : 0;
}

// The built-in track to compare with: a dialogue track, in the language that will be heard when
// there is one, else the first. Any language does: lines come and go where people speak.
// { index, lang } or null.
export function referenceTrack(tracks, audioLangs) {
  const own = dialogueTracks(tracks);
  if (!own.length) return null;
  const audio = ((tracks && tracks.audio) || [])[soundTrack(tracks, audioLangs)];
  const heard = audio ? ofTrack(audio.lang, audio.label) : '';
  return own.find((x) => heard && x.lang === heard) || own[0];
}

// o.tracks: the file's { audio, subs } (null when the server couldn't list them: sound only)
// o.subs: the add-on subtitles to test      o.keyOf(sub), o.cues(sub) -> Promise<[{ start, end }]>
// o.at: seconds into the film               o.audioLangs: wanted audio languages, canonical
// o.loader(index) -> a lib/embedsubs.js Loader for that built-in track
// o.sampler(audioIndex, from, seconds, onDone, onFail) -> a lib/soundsample.js Sampler, or null
// o.known: earlier answers for this file (not tested again)     o.onResult(key, answer)
// o.clock() -> ms (optional)
// Call tick() a few times a second until done(); stop() lets go of the server.
export function Session(o) {
  const ref = referenceTrack(o.tracks, o.audioLangs);
  let loader = null;
  let loaderDone = false;
  const checker = Checker({
    candidates: () => o.subs.map((s) => ({ key: o.keyOf(s), cues: () => o.cues(s) })),
    track: () => {
      if (!ref) return null;
      if (!loader) loader = o.loader(ref.index);
      return { covered: loader.covered, cues: loader.cues, failed: loader.failed };
    },
    sound: (from, seconds, onDone, onFail) => o.sampler(soundTrack(o.tracks, o.audioLangs), from, seconds, onDone, onFail),
    known: o.known,
    onResult: o.onResult,
    clock: o.clock,
  });
  checker.start(o.at);

  function dropLoader() {
    if (!loader || loaderDone) return;
    loaderDone = true;
    loader.stop();
  }

  return {
    tick: () => {
      checker.tick(true, o.at);
      if (loader && !loaderDone) {
        if (checker.needsTrack()) loader.want(checker.wantAt());
        else dropLoader(); // compared, or given up on: the server can stop reading
      }
    },
    done: () => checker.done(),
    // For the panel: what it is doing ('track' | 'sound' | 'compare' | 'done' | 'off'), how far
    // along the reading is (0..1), the built-in track compared with, and why it stopped.
    status: () => {
      const s = checker.summary();
      let step = 'compare';
      let progress = 1;
      if (checker.done()) step = s.phase === 'off' ? 'off' : 'done';
      else if (s.phase === 'ref' && s.via === 'track') {
        step = 'track';
        const cov = loader ? loader.covered(o.at) : null;
        progress = cov ? Math.min(0.99, (cov.to - cov.from) / TRACK_SPAN) : 0;
      } else if (s.phase === 'ref' || s.phase === 'idle') {
        step = 'sound';
        progress = s.loading;
      }
      return { step: step, progress: progress, track: s.via === 'track' && ref ? ref : null, why: s.why };
    },
    // The PC is reading the file for this right now.
    reading: () => checker.pcReading() || (!!loader && !loaderDone && loader.reading()),
    stop: () => {
      checker.stop();
      dropLoader();
    },
  };
}
