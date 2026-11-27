// Tests, while a video plays, which add-on subtitles keep time with this file (lib/subsync.js does
// the measuring; this decides what to measure against, when, and what the answers add up to).
// What a subtitle is compared with, in this order:
//   1. a built-in subtitle track of the file, when it has one that is text: exact, and cheap when
//      the player is loading that track anyway;
//   2. the sound: a few minutes of it, fetched once through the PC's Stremio server.
// Either way the PC reads part of the file next to the TV's own stream, so this only moves when
// the player says the PC may read (tick(allowed)), and stops asking once it has what it needs.
// Answers per subtitle: 'ok' (in time), 'shift' (in time once moved by `shift` seconds), 'bad'
// (doesn't follow this file), 'unsure'. The sound alone never condemns a subtitle: a scene carried
// by music hides the voices, so "no fit" only counts there when another subtitle did fit.
// No DOM, no network and no clock of its own (all passed in), so it runs under `npm test`.
import { timeline, speech, cuesWithin, Match, verdict } from './subsync.js';

export const TRACK_SPAN = 180; // seconds of a built-in track needed before comparing...
export const TRACK_LINES = 12; // ...holding at least this many lines (the fewest the measurements were made with)
export const TRACK_SPAN_MAX = 600; // the comparison never looks at more than this
export const TRACK_LINES_MIN = 10; // with that much in, this many lines will do
export const TRACK_GIVE_UP = 1800; // a track still that quiet after this long is no dialogue track
export const SOUND_SPAN = 360; // seconds of sound fetched at a time
export const SOUND_ROUNDS = 2; // a second helping, once, when the first settles nothing
export const MAX_CANDIDATES = 8; // subtitles tested per video (each one is a download)
const BUDGET_MS = 6; // arithmetic per tick: the screen must not wait on this

// o.candidates() -> [{ key, cues() -> Promise<[{ start, end }]> }], most wanted first; asked on
//   every tick, since add-ons answer one after another
// o.track() -> null, or the built-in track to compare with: { covered(time) -> { from, to } | null,
//   cues() -> [...], failed() -> bool }. Loading it is the player's business (see wantAt()).
// o.sound(from, seconds, onDone, onFail) -> a lib/soundsample.js Sampler, or null when this
//   device can't decode sound
// o.known: answers from an earlier viewing of the same file, { key: { state, shift } }: not tested again
// o.onResult(key, { state, shift, via }): a new or changed answer
// o.clock() -> ms (optional)
export function Checker(o) {
  const clock = o.clock || Date.now;
  const known = o.known || {};
  let phase = 'idle'; // 'idle' | 'ref' (getting what to compare with) | 'score' | 'off'
  let via = ''; // 'track' | 'sound'
  let started = false;
  let at = 0; // where in the film the stretch begins
  let ref = null;
  let refFrom = 0;
  let refTo = 0;
  let trackWant = 0;
  let sampler = null;
  let sound = null; // { from, to, mid, side } so far
  let rounds = 0;
  let settled = false; // every subtitle on the list has its answer
  let heardOut = false; // ...and has had, once, since the stretch compared last changed
  let why = '';
  let raw = {}; // key -> { res } | { error: true }
  const out = {}; // key -> the answer as last reported
  let job = null; // { key, match }: the subtitle being compared

  function pending() {
    return o
      .candidates()
      .slice(0, MAX_CANDIDATES)
      .filter((c) => !raw[c.key] && !known[c.key]);
  }

  function answerFor(key) {
    const x = raw[key];
    if (!x || x.error) return { state: 'unsure', shift: 0, via: via };
    const v = verdict(x.res, via);
    v.via = via;
    return v;
  }

  function anyFits() {
    return Object.keys(raw).some((k) => {
      const s = answerFor(k).state;
      return s === 'ok' || s === 'shift';
    });
  }

  function publish() {
    const fits = anyFits();
    Object.keys(raw).forEach((key) => {
      const v = answerFor(key);
      // Against the sound, "no fit" means something only once all are in and another one fitted.
      if (via === 'sound' && v.state === 'bad' && !(heardOut && fits)) v.state = 'unsure';
      const last = out[key];
      if (last && last.state === v.state && last.shift === v.shift) return;
      out[key] = v;
      o.onResult(key, v);
    });
  }

  function useSound(s) {
    if (sound && Math.abs(s.from - sound.to) < 0.05) {
      const mid = new Float32Array(sound.mid.length + s.mid.length);
      const side = new Float32Array(sound.side.length + s.side.length);
      mid.set(sound.mid, 0);
      mid.set(s.mid, sound.mid.length);
      side.set(sound.side, 0);
      side.set(s.side, sound.side.length);
      sound = { from: sound.from, to: s.to, mid: mid, side: side };
    } else sound = s;
    rounds++;
    sampler = null;
    ref = speech(sound.mid, sound.side);
    refFrom = sound.from;
    refTo = sound.to;
    raw = {}; // everything is compared again over the longer stretch
    job = null;
    settled = false;
    heardOut = false;
    phase = 'score';
  }

  function soundFailed(reason) {
    sampler = null;
    why = reason === 'decode' ? "this device can't decode the sound" : "the PC server didn't hand out the sound";
    if (!rounds) {
      phase = 'off';
      return;
    }
    // The first helping stands.
    phase = 'score';
    settled = heardOut = true;
    publish();
  }

  // The longer of the stretches in around where the check began and around the playhead.
  function widest(tr, now) {
    const a = tr.covered(at);
    const b = tr.covered(now);
    if (!a) return b;
    if (!b) return a;
    return b.to - b.from > a.to - a.from ? b : a;
  }

  function reference(allowed, now) {
    if (via !== 'sound') {
      const tr = o.track();
      if (tr && !tr.failed()) {
        via = 'track';
        const cov = widest(tr, now);
        trackWant = cov ? Math.max(at, cov.to - 60) : at;
        if (!cov) return;
        const to = cov.to;
        const from = Math.max(cov.from, to - TRACK_SPAN_MAX);
        const lines = cuesWithin(tr.cues(), from, to);
        if ((to - from >= TRACK_SPAN && lines >= TRACK_LINES) || (to - from >= TRACK_SPAN_MAX - 1 && lines >= TRACK_LINES_MIN)) {
          ref = timeline(tr.cues(), from, to);
          refFrom = from;
          refTo = to;
          phase = 'score';
          return;
        }
        if (to - cov.from < TRACK_GIVE_UP) return; // more of the track is on its way
      }
      via = 'sound'; // no text track, the server can't read it, or it holds no dialogue
    }
    if (!sampler) {
      sampler = o.sound(sound ? sound.to : at, SOUND_SPAN, useSound, soundFailed);
      if (!sampler) {
        why = "this device can't decode sound";
        phase = rounds ? 'score' : 'off';
        if (rounds) {
          settled = heardOut = true;
          publish();
        }
        return;
      }
    }
    if (allowed) sampler.go();
    else sampler.rest();
  }

  function score(list) {
    if (!job) {
      const c = list[0];
      if (!c) return settle();
      const mine = (job = { key: c.key, match: null });
      c.cues().then(
        (cues) => {
          if (job === mine) mine.match = Match(ref, refFrom, cues);
        },
        () => {
          if (job !== mine) return;
          raw[mine.key] = { error: true };
          job = null;
        }
      );
      return;
    }
    if (!job.match) return; // its file is still downloading
    const t0 = clock();
    let done = false;
    while (!done && clock() - t0 < BUDGET_MS) done = job.match.step(25);
    if (!done) return;
    raw[job.key] = { res: job.match.result() };
    job = null;
    publish();
  }

  // Every subtitle on the list has its numbers.
  function settle() {
    if (settled) return;
    const scored = Object.keys(raw).some((k) => !raw[k].error);
    if (via === 'sound' && scored && !anyFits() && rounds < SOUND_ROUNDS) {
      phase = 'ref'; // nothing stood out: listen to the next stretch as well
      return;
    }
    settled = heardOut = true;
    publish();
  }

  return {
    // The video has been playing for a moment, at `time` seconds: from here on tick() may work.
    start: (time) => {
      if (started) return;
      started = true;
      at = Math.floor(Math.max(0, time) / 10) * 10;
      trackWant = at;
    },
    // Call a few times a second. allowed: the PC may read the file now. now: the playhead (s).
    tick: (allowed, now) => {
      if (!started || phase === 'off') return;
      if (phase === 'ref') return reference(allowed, now);
      const list = pending();
      if (phase === 'idle') {
        if (!list.length) return;
        phase = 'ref';
        return reference(allowed, now);
      }
      if (list.length) settled = false; // a subtitle that came later: one more to go
      score(list);
    },
    // The built-in track is needed (the player keeps it loading), and from where in the film.
    needsTrack: () => started && phase === 'ref' && via === 'track',
    wantAt: () => trackWant,
    // A subtitle on the list that has no answer yet.
    waiting: (key) => started && phase !== 'off' && !out[key] && !known[key] && pending().some((c) => c.key === key),
    // The PC is reading the file for this right now.
    pcReading: () => !!sampler && sampler.reading(),
    // For the diagnostics screen.
    summary: () => {
      const count = { ok: 0, shift: 0, bad: 0, unsure: 0 };
      Object.keys(out).forEach((k) => count[out[k].state]++);
      return {
        phase: phase,
        via: via,
        from: refFrom,
        to: refTo,
        loading: sampler ? sampler.progress() : 0,
        tested: Object.keys(out).length,
        count: count,
        why: why,
      };
    },
    stop: () => {
      phase = 'off';
      job = null;
      if (sampler) sampler.stop();
      sampler = null;
    },
  };
}
