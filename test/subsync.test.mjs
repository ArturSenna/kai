import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, FRAME, timeline, cuesWithin, energies, speech, match, Match, verdict, MIN_LINES } from '../src/js/lib/subsync.js';

// A made-up film: lines of dialogue at irregular moments, always the same for a given seed.
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
// The same film with the lines cut differently, as another translator would.
const retimed = (cues, seed) => {
  const rand = rng(seed);
  return cues.map((c) => ({ start: c.start + (rand() - 0.5) * 0.5, end: c.end + (rand() - 0.3) * 0.8, text: c.text }));
};

// Sound for that film at 8 kHz: voices in both speakers alike, going up and down like syllables,
// over a steady background that differs between the speakers.
function soundFor(cues, seconds, seed) {
  const rate = 8000;
  const rand = rng(seed);
  const n = Math.round(seconds * rate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const on = timeline(cues, 0, seconds);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const speaking = on[Math.min(on.length - 1, Math.floor(t / STEP))] > 0.5;
    const syllable = Math.pow(Math.abs(Math.sin(Math.PI * 4.3 * t + Math.sin(t * 0.7))), 3);
    const voice = speaking ? (rand() - 0.5) * 0.5 * syllable : 0;
    left[i] = voice + (rand() - 0.5) * 0.08;
    right[i] = voice + (rand() - 0.5) * 0.08;
  }
  return { left, right, rate };
}

test('a subtitle becomes a line over time: the share of each step with text on screen', () => {
  const line = timeline([{ start: 1.0, end: 1.25 }, { start: 5, end: 6 }], 0, 10);
  assert.equal(line.length, Math.round(10 / STEP));
  assert.ok(Math.abs(line[10] - 1) < 1e-6);
  assert.ok(Math.abs(line[11] - 1) < 1e-6);
  assert.ok(Math.abs(line[12] - 0.5) < 1e-6);
  assert.equal(line[13], 0);
  assert.equal(line[55], 1);
  // A stretch that doesn't start at the film's start.
  assert.equal(timeline([{ start: 101, end: 102 }], 100, 110)[15], 1);
  assert.equal(cuesWithin([{ start: 1 }, { start: 5 }, { start: 9 }], 4, 9), 1);
});

test('against a built-in track: the same lines are in time, moved lines are told by how much', () => {
  const film = dialogue(1, 1500);
  const ref = timeline(film, 600, 900); // five minutes, starting ten minutes in
  const same = match(ref, 600, retimed(film, 7));
  assert.ok(Math.abs(same.shift) <= 0.3, 'shift ' + same.shift);
  assert.deepEqual(verdict(same, 'track'), { state: 'ok', shift: 0 });

  // Lines that come 12.5 s late have to be brought forward by 12.5 s.
  const late = match(ref, 600, moved(retimed(film, 7), 12.5));
  assert.ok(Math.abs(late.shift + 12.5) <= 0.3, 'shift ' + late.shift);
  const v = verdict(late, 'track');
  assert.equal(v.state, 'shift');
  assert.ok(Math.abs(v.shift + 12.5) <= 0.3);

  const early = match(ref, 600, moved(film, -30));
  assert.ok(Math.abs(early.shift - 30) <= 0.2, 'shift ' + early.shift);
  assert.equal(verdict(early, 'track').state, 'shift');
});

test("against a built-in track: another film's subtitle, or one at another speed, doesn't fit", () => {
  const film = dialogue(1, 1500);
  const ref = timeline(film, 600, 900);
  assert.equal(verdict(match(ref, 600, dialogue(2, 1500)), 'track').state, 'bad');
  assert.equal(verdict(match(ref, 600, dialogue(3, 1500)), 'track').state, 'bad');
  // Timed for 25 pictures a second, playing at 23.976: by minute ten it is 25 s out and drifting.
  const pal = film.map((c) => ({ start: (c.start * 23.976) / 25, end: (c.end * 23.976) / 25, text: c.text }));
  assert.notEqual(verdict(match(ref, 600, pal), 'track').state, 'ok');
});

test('too few lines in the stretch say nothing either way', () => {
  const film = dialogue(1, 1500);
  const ref = timeline(film, 600, 900);
  const few = film.filter((c) => c.start < 600 || c.start > 900).concat(film.filter((c) => c.start >= 600 && c.start <= 900).slice(0, MIN_LINES - 4));
  assert.equal(verdict(match(ref, 600, few), 'track').state, 'unsure');
  assert.equal(verdict(match(ref, 600, []), 'track').state, 'unsure');
});

test('off by more than can be told: the best fit sits at the very end of the reach', () => {
  const film = dialogue(1, 1500);
  const ref = timeline(film, 600, 900);
  // 20 s of reach, lines 20 s late: the fit is still climbing where the reach ends.
  const res = match(ref, 600, moved(film, 20), 20);
  assert.equal(res.edge, true);
  assert.equal(verdict(res, 'track').state, 'bad');
});

test('the comparison can be done a few shifts at a time and gives the same answer', () => {
  const film = dialogue(4, 900);
  const ref = timeline(film, 100, 400);
  const whole = match(ref, 100, moved(film, 3));
  const m = Match(ref, 100, moved(film, 3));
  let turns = 0;
  while (!m.step(50)) turns++;
  assert.ok(turns > 10);
  assert.deepEqual(m.result(), whole);
});

test('sound becomes loudness in the middle and at the sides, whatever the sample rate', () => {
  const rate = 48000;
  const n = rate; // one second
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tone = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
    left[i] = i < n / 2 ? tone : tone; // first half: the same in both speakers
    right[i] = i < n / 2 ? tone : -tone; // second half: opposite
  }
  const e = energies(left, right, rate);
  assert.equal(e.mid.length, Math.round(1 / FRAME));
  assert.ok(e.mid[10] > 100 * e.side[10]);
  assert.ok(e.side[40] > 100 * e.mid[40]);
  // Mono: nothing at the sides.
  const mono = energies(left, null, rate);
  assert.ok(mono.mid[10] > 0);
  assert.equal(mono.side[10], 0);
  assert.equal(energies(left.subarray(0, 8000), null, 8000).mid.length, Math.round(1 / FRAME));
});

test('against the sound: the right subtitle is in time, a moved one is told by how much, a wrong one is not taken', () => {
  const seconds = 420;
  const film = dialogue(5, seconds);
  const s = soundFor(film, seconds, 11);
  const e = energies(s.left, s.right, s.rate);
  const ref = speech(e.mid, e.side);
  assert.equal(ref.length, Math.floor(e.mid.length / Math.round(STEP / FRAME)));

  const right = match(ref, 0, retimed(film, 9));
  assert.ok(Math.abs(right.shift) <= 0.5, 'shift ' + right.shift);
  assert.equal(verdict(right, 'sound').state, 'ok');

  const late = verdict(match(ref, 0, moved(film, 8)), 'sound');
  assert.equal(late.state, 'shift');
  assert.ok(Math.abs(late.shift + 8) <= 0.5, 'shift ' + late.shift);

  const wrong = verdict(match(ref, 0, dialogue(6, seconds)), 'sound').state;
  assert.ok(wrong === 'bad' || wrong === 'unsure', wrong);
});

test('mono sound still tells the right subtitle', () => {
  const seconds = 420;
  const film = dialogue(8, seconds);
  const s = soundFor(film, seconds, 12);
  const e = energies(s.left, null, s.rate);
  const res = match(speech(e.mid, e.side), 0, film);
  assert.equal(verdict(res, 'sound').state, 'ok');
});
