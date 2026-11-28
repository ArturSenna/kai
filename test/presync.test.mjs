import test from 'node:test';
import assert from 'node:assert/strict';
import { startAt, candidates, soundTrack, referenceTrack, Session } from '../src/js/lib/presync.js';
import { BLOCK } from '../src/js/lib/embedsubs.js';

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

test('the stretch tested starts a fifth of the way in, between 2 and 15 minutes', () => {
  assert.equal(startAt(45 * 60), 540);
  assert.equal(startAt(110 * 60), 900);
  assert.equal(startAt(8 * 60), 120);
  assert.equal(startAt(0), 900);
});

test('the subtitles tested: the first-choice languages when an add-on has them, else the second choice', () => {
  const subs = [
    { id: 1, lang: 'eng' },
    { id: 2, lang: 'por' },
    { id: 3, lang: 'pob' },
    { id: 4, lang: 'spa' },
    { id: 5, lang: 'pt-BR' },
  ];
  const groups = [['pt-br', 'pt'], ['en']];
  assert.deepEqual(candidates(subs, groups).map((s) => s.id), [3, 5, 2]);
  assert.deepEqual(candidates([subs[0], subs[3]], groups).map((s) => s.id), [1]);
  assert.deepEqual(candidates([subs[3]], groups), []);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: i, lang: 'pob' }));
  assert.equal(candidates(many, groups).length, 8);
});

const FILE = {
  audio: [
    { lang: 'eng', label: 'English' },
    { lang: 'por', label: 'Português (Brasil)' },
  ],
  subs: [
    { lang: 'eng', label: 'SDH', codec: 'subrip' },
    { lang: 'por', label: 'Forced', codec: 'subrip' },
    { lang: 'por', label: 'Brasil', codec: 'subrip' },
  ],
};

test('compared with: a dialogue track in the language that will be heard, else the first', () => {
  assert.equal(soundTrack(FILE, ['pt-br', 'pt']), 1);
  assert.equal(soundTrack(FILE, []), 0);
  assert.deepEqual(referenceTrack(FILE, ['pt-br', 'pt']), { index: 2, lang: 'pt-br', title: 'Brasil' });
  assert.deepEqual(referenceTrack(FILE, []), { index: 0, lang: 'en', title: 'SDH' });
  assert.equal(referenceTrack({ audio: [], subs: [] }, []), null);
  assert.equal(soundTrack(null, ['en']), 0);
});

// A built-in track the server hands out ten seconds at a time, from wherever it is asked.
function fakeLoader(cues) {
  const have = {};
  const asked = [];
  let stopped = false;
  return {
    asked,
    stopped: () => stopped,
    want: (time) => {
      asked.push(time);
      const k = Math.floor(time / BLOCK);
      for (let i = k; i < k + 30; i++) have[i] = true; // the next five minutes come in at once
    },
    covered: (time) => {
      let a = Math.floor(time / BLOCK);
      if (!have[a]) return null;
      let b = a;
      while (have[a - 1]) a--;
      while (have[b + 1]) b++;
      return { from: a * BLOCK, to: (b + 1) * BLOCK };
    },
    cues: () => cues.filter((c) => have[Math.floor(c.start / BLOCK)]),
    failed: () => false,
    reading: () => !stopped,
    stop: () => (stopped = true),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('with a built-in track: reads it where the test begins, tells in time and shifted apart, then lets the server go', async () => {
  const film = dialogue(1, 3000);
  const subs = [
    { id: 'right', lang: 'pob', cues: film },
    { id: 'late', lang: 'pob', cues: moved(film, 2.5) },
    { id: 'other', lang: 'pob', cues: dialogue(2, 3000) },
  ];
  let loader = null;
  const results = {};
  const s = Session({
    tracks: FILE,
    subs: subs,
    keyOf: (x) => x.id,
    cues: (x) => Promise.resolve(x.cues),
    at: 600,
    audioLangs: ['en'],
    loader: (index) => {
      assert.equal(index, 0); // the English track: English will be heard
      return (loader = fakeLoader(film));
    },
    sampler: () => assert.fail('no sound needed'),
    known: {},
    onResult: (key, v) => (results[key] = v),
  });
  s.tick();
  assert.equal(s.status().step, 'track');
  assert.equal(loader.asked[0], 600);
  for (let i = 0; i < 200 && !s.done(); i++) {
    s.tick();
    await settle();
  }
  assert.equal(s.done(), true);
  assert.equal(s.status().step, 'done');
  assert.equal(results.right.state, 'ok');
  assert.ok(results.right.conf > 0.9);
  assert.equal(results.late.state, 'shift');
  assert.ok(Math.abs(results.late.shift + 2.5) <= 0.1, 'shift ' + results.late.shift);
  assert.equal(results.other.state, 'bad');
  assert.equal(loader.stopped(), true); // the server stops reading the file
  s.stop();
});

test('no track list from the server: the sound of the first audio track is asked for', () => {
  const asked = [];
  const s = Session({
    tracks: null,
    subs: [{ id: 'a', lang: 'pob', cues: [] }],
    keyOf: (x) => x.id,
    cues: (x) => Promise.resolve(x.cues),
    at: 300,
    audioLangs: ['pt-br'],
    loader: () => assert.fail('no track to read'),
    sampler: (audio, from, seconds) => {
      asked.push([audio, from, seconds]);
      return { go: () => {}, rest: () => {}, stop: () => {}, reading: () => true, progress: () => 0.25 };
    },
    known: {},
    onResult: () => {},
  });
  s.tick();
  assert.deepEqual(asked, [[0, 300, 360]]);
  assert.deepEqual([s.status().step, s.status().progress], ['sound', 0.25]);
  assert.equal(s.reading(), true);
  assert.equal(s.done(), false);
});

test('answers already known for this file are not worked out again', () => {
  const s = Session({
    tracks: FILE,
    subs: [{ id: 'a', lang: 'pob', cues: [] }],
    keyOf: (x) => x.id,
    cues: () => assert.fail('nothing to download'),
    at: 300,
    audioLangs: [],
    loader: () => assert.fail('nothing to read'),
    sampler: () => assert.fail('nothing to hear'),
    known: { a: { state: 'ok', shift: 0 } },
    onResult: () => assert.fail('nothing new'),
  });
  s.tick();
  assert.equal(s.done(), true);
});
