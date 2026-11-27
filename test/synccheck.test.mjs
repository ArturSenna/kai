import test from 'node:test';
import assert from 'node:assert/strict';
import { Checker, TRACK_SPAN, SOUND_SPAN, MAX_CANDIDATES } from '../src/js/lib/synccheck.js';
import { FRAME } from '../src/js/lib/subsync.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A made-up film's dialogue: about a dozen lines a minute, with the odd long silence.
function dialogue(seed, seconds) {
  const rand = rng(seed);
  const cues = [];
  let t = 2 + rand() * 5;
  while (t < seconds - 6) {
    const len = 1 + rand() * 3.5;
    cues.push({ start: t, end: t + len, text: 'line ' + cues.length });
    t += len + (rand() < 0.2 ? 6 + rand() * 20 : 0.2 + rand() * 3);
  }
  return cues;
}

const moved = (cues, by) => cues.map((c) => ({ start: c.start + by, end: c.end + by, text: c.text }));

// Loudness for a stretch of that film, as lib/soundsample.js would hand it over: lively and in
// the middle while someone speaks, steady and all around otherwise. clear = false: voices buried.
function soundOf(cues, from, to, seed, clear) {
  const rand = rng(seed);
  const n = Math.round((to - from) / FRAME);
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const t = from + f * FRAME;
    const speaking = clear !== false && cues.some((c) => t >= c.start && t < c.end);
    mid[f] = speaking ? 0.02 * Math.pow(Math.abs(Math.sin(Math.PI * 4.3 * t)), 3) * (0.5 + rand()) + 0.0005 : 0.004 * (0.9 + 0.2 * rand());
    side[f] = speaking ? 0.0005 : 0.004 * (0.9 + 0.2 * rand());
  }
  return { from, to, mid, side };
}

const FILM = dialogue(1, 3000);

function rig(opts) {
  const o = opts || {};
  const results = {};
  const log = [];
  let ms = 0;
  const track = o.track === undefined ? null : o.track;
  const sounds = []; // what was asked of the sound: { from, seconds, done, fail, calls: [] }
  const subs = o.subs || { right: FILM };
  const list = Object.keys(subs).map((key) => ({ key, cues: () => (subs[key] === 'broken' ? Promise.reject(new Error('no')) : Promise.resolve(subs[key])) }));
  const checker = Checker({
    candidates: () => list,
    track: () => (typeof track === 'function' ? track() : track),
    sound: (from, seconds, done, fail) => {
      if (o.noDecoder) return null;
      const s = { from, seconds, done, fail, calls: [], reading: false };
      sounds.push(s);
      return { go: () => s.calls.push('go'), rest: () => s.calls.push('rest'), stop: () => s.calls.push('stop'), reading: () => s.reading, progress: () => 0.5 };
    },
    known: o.known,
    onResult: (key, v) => {
      results[key] = v;
      log.push(key + ':' + v.state);
    },
    clock: () => (ms += 1), // every look at the clock costs a millisecond
  });
  // Ticks until `until()` holds (the arithmetic is spread over many ticks).
  const run = async (until, allowed, now) => {
    for (let i = 0; i < 400 && !until(); i++) {
      checker.tick(allowed !== false, now || 0);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
    assert.ok(until(), 'never got there');
  };
  return { checker, results, log, sounds, list, run };
}

// A built-in track as the player holds it: the text that is in so far.
function trackOf(cues, state) {
  return { covered: (t) => (state.to > state.from && t >= state.from && t < state.to ? { from: state.from, to: state.to } : null), cues: () => cues.filter((c) => c.start < state.to), failed: () => !!state.failed };
}

test('nothing happens before start(), and nothing is read while there is nothing to test', () => {
  const r = rig({ subs: {}, track: () => assert.fail('the track must not be asked for') });
  r.checker.tick(true, 0);
  r.checker.start(300);
  r.checker.tick(true, 300);
  r.checker.tick(true, 301);
  assert.equal(r.sounds.length, 0);
  assert.equal(r.checker.needsTrack(), false);
  assert.equal(r.checker.summary().phase, 'idle');
});

test('with a built-in track: waits for three minutes of it, then tells in time, shifted and wrong apart', async () => {
  const state = { from: 600, to: 600 };
  const r = rig({ track: trackOf(FILM, state), subs: { right: FILM, late: moved(FILM, 7.5), other: dialogue(2, 3000) } });
  r.checker.start(603);
  r.checker.tick(true, 603);
  assert.equal(r.checker.needsTrack(), true);
  assert.equal(r.checker.wantAt(), 600); // the stretch begins on a block's edge
  assert.equal(r.checker.waiting('right'), true);
  state.to = 600 + TRACK_SPAN - 10;
  r.checker.tick(true, 610);
  assert.equal(r.checker.summary().phase, 'ref'); // not enough yet
  assert.equal(r.checker.wantAt(), state.to - 60); // ...so the track is read further on
  state.to = 600 + TRACK_SPAN + 60;
  await r.run(() => Object.keys(r.results).length === 3);
  assert.equal(r.checker.needsTrack(), false); // the player may let go of the track
  assert.equal(r.sounds.length, 0); // the sound was never needed
  assert.deepEqual(r.results.right, { state: 'ok', shift: 0, via: 'track' });
  assert.equal(r.results.late.state, 'shift');
  assert.ok(Math.abs(r.results.late.shift + 7.5) <= 0.3, 'shift ' + r.results.late.shift);
  assert.equal(r.results.other.state, 'bad');
  assert.equal(r.checker.waiting('right'), false);
  const s = r.checker.summary();
  assert.deepEqual([s.via, s.from, s.to, s.tested], ['track', 600, state.to, 3]);
  assert.deepEqual(s.count, { ok: 1, shift: 1, bad: 1, unsure: 0 });
});

test('the arithmetic is spread over several ticks', async () => {
  const state = { from: 0, to: 300 };
  const r = rig({ track: trackOf(FILM, state) });
  r.checker.start(0);
  let ticks = 0;
  await r.run(() => (ticks++, !!r.results.right));
  assert.ok(ticks > 5, 'done in ' + ticks + ' ticks');
});

test('answers from an earlier viewing of the same file are not worked out again', () => {
  const r = rig({ known: { right: { state: 'ok', shift: 0 } }, track: () => assert.fail('nothing to read the track for') });
  r.checker.start(100);
  r.checker.tick(true, 100);
  r.checker.tick(true, 101);
  assert.equal(r.sounds.length, 0);
  assert.equal(r.checker.waiting('right'), false);
});

test('a quiet track is waited on: enough lines, or ten minutes of it', async () => {
  const quiet = FILM.filter((c, i) => i % 6 === 0); // a line or two a minute
  const state = { from: 0, to: 400 };
  const r = rig({ track: trackOf(quiet, state), subs: { right: quiet } });
  r.checker.start(0);
  r.checker.tick(true, 0);
  assert.equal(r.checker.summary().phase, 'ref');
  state.to = 1000;
  await r.run(() => !!r.results.right);
  assert.equal(r.results.right.state, 'ok');
  const s = r.checker.summary();
  assert.equal(s.to - s.from, 600); // never more than ten minutes
});

test('no built-in track: the sound is fetched, only while the PC may read', async () => {
  const r = rig({ subs: { right: FILM, late: moved(FILM, -11) } });
  r.checker.start(1205);
  r.checker.tick(false, 1205);
  assert.equal(r.sounds.length, 1);
  assert.deepEqual([r.sounds[0].from, r.sounds[0].seconds], [1200, SOUND_SPAN]);
  assert.deepEqual(r.sounds[0].calls, ['rest']); // the video is short of data: hands off
  r.checker.tick(true, 1206);
  assert.deepEqual(r.sounds[0].calls, ['rest', 'go']);
  r.sounds[0].reading = true;
  assert.equal(r.checker.pcReading(), true);
  r.sounds[0].reading = false;
  r.sounds[0].done(soundOf(FILM, 1200, 1200 + SOUND_SPAN, 3));
  assert.equal(r.checker.pcReading(), false);
  await r.run(() => Object.keys(r.results).length === 2);
  assert.equal(r.results.right.state, 'ok');
  assert.equal(r.results.right.via, 'sound');
  assert.equal(r.results.late.state, 'shift');
  assert.ok(Math.abs(r.results.late.shift - 11) <= 0.5, 'shift ' + r.results.late.shift);
  assert.equal(r.sounds.length, 1); // one helping was enough
});

test('against the sound, "no fit" counts only when another subtitle did fit', async () => {
  const withRight = rig({ subs: { other: dialogue(2, 3000), right: FILM } });
  withRight.checker.start(600);
  withRight.checker.tick(true, 600);
  withRight.sounds[0].done(soundOf(FILM, 600, 600 + SOUND_SPAN, 3));
  await withRight.run(() => withRight.checker.summary().count.ok === 1 && withRight.results.other.state === 'bad');
  // The wrong one was held back as "unsure" until the right one had fitted.
  assert.deepEqual(withRight.log, ['other:unsure', 'right:ok', 'other:bad']);

  const alone = rig({ subs: { other: dialogue(2, 3000) } });
  alone.checker.start(600);
  alone.checker.tick(true, 600);
  alone.sounds[0].done(soundOf(FILM, 600, 600 + SOUND_SPAN, 3));
  // Nothing stood out: the next stretch is listened to as well, once.
  await alone.run(() => alone.sounds.length === 2);
  assert.deepEqual([alone.sounds[1].from, alone.sounds[1].seconds], [600 + SOUND_SPAN, SOUND_SPAN]);
  alone.sounds[1].done(soundOf(FILM, 600 + SOUND_SPAN, 600 + 2 * SOUND_SPAN, 4));
  await alone.run(() => alone.checker.summary().to === 600 + 2 * SOUND_SPAN && alone.checker.waiting('other') === false && alone.checker.summary().phase === 'score');
  for (let i = 0; i < 60; i++) alone.checker.tick(true, 600);
  assert.equal(alone.results.other.state, 'unsure'); // never "doesn't follow this file" on the sound's word alone
  assert.equal(alone.sounds.length, 2);
});

test('a scene where the voices are buried: the second stretch settles it', async () => {
  const r = rig();
  r.checker.start(600);
  r.checker.tick(true, 600);
  r.sounds[0].done(soundOf(FILM, 600, 600 + SOUND_SPAN, 3, false));
  await r.run(() => r.sounds.length === 2);
  assert.equal(r.results.right.state, 'unsure');
  r.sounds[1].done(soundOf(FILM, 600 + SOUND_SPAN, 600 + 2 * SOUND_SPAN, 4));
  await r.run(() => r.results.right.state === 'ok');
});

test("a track the server can't read: the sound takes over", async () => {
  const state = { from: 0, to: 0 };
  const r = rig({ track: trackOf(FILM, state) });
  r.checker.start(0);
  r.checker.tick(true, 0);
  assert.equal(r.sounds.length, 0);
  state.failed = true;
  r.checker.tick(true, 1);
  assert.equal(r.sounds.length, 1);
  assert.equal(r.checker.needsTrack(), false);
  r.sounds[0].done(soundOf(FILM, 0, SOUND_SPAN, 3));
  await r.run(() => !!r.results.right);
  assert.equal(r.results.right.state, 'ok');
});

test("a device that can't decode sound, or a server that won't hand it out: it stops and says why", () => {
  const none = rig({ noDecoder: true });
  none.checker.start(0);
  none.checker.tick(true, 0);
  assert.equal(none.checker.summary().phase, 'off');
  assert.match(none.checker.summary().why, /decode/);
  assert.equal(none.checker.waiting('right'), false);

  const refused = rig();
  refused.checker.start(0);
  refused.checker.tick(true, 0);
  refused.sounds[0].fail('server');
  assert.equal(refused.checker.summary().phase, 'off');
  assert.match(refused.checker.summary().why, /PC server/);
  refused.checker.tick(true, 1);
  assert.equal(refused.sounds.length, 1); // not asked again
});

test("a subtitle that won't download is left unsure, and the rest are still tested", async () => {
  const state = { from: 0, to: 300 };
  const r = rig({ track: trackOf(FILM, state), subs: { gone: 'broken', right: FILM } });
  r.checker.start(0);
  await r.run(() => !!r.results.right);
  assert.equal(r.results.right.state, 'ok');
  await r.run(() => !!r.results.gone);
  assert.equal(r.results.gone.state, 'unsure');
});

test('a subtitle that turns up later is tested against what is already in', async () => {
  const state = { from: 0, to: 300 };
  const r = rig({ track: trackOf(FILM, state) });
  r.checker.start(0);
  await r.run(() => !!r.results.right);
  r.list.push({ key: 'later', cues: () => Promise.resolve(moved(FILM, 2)) });
  assert.equal(r.checker.waiting('later'), true);
  await r.run(() => !!r.results.later);
  assert.equal(r.results.later.state, 'shift');
});

test('no more than a handful of subtitles are tested per video', async () => {
  const subs = {};
  for (let i = 0; i < MAX_CANDIDATES + 3; i++) subs['s' + i] = FILM;
  const state = { from: 0, to: 300 };
  const r = rig({ track: trackOf(FILM, state), subs });
  r.checker.start(0);
  await r.run(() => Object.keys(r.results).length === MAX_CANDIDATES);
  for (let i = 0; i < 40; i++) r.checker.tick(true, 0);
  assert.equal(Object.keys(r.results).length, MAX_CANDIDATES);
  assert.equal(r.checker.waiting('s' + MAX_CANDIDATES), false);
});

test('stop() ends it and lets go of the sound', () => {
  const r = rig();
  r.checker.start(0);
  r.checker.tick(true, 0);
  r.checker.stop();
  assert.deepEqual(r.sounds[0].calls, ['go', 'stop']);
  r.checker.tick(true, 1);
  assert.equal(r.checker.summary().phase, 'off');
});
