import test from 'node:test';
import assert from 'node:assert/strict';
import { Watch, SETTLE_MS, FREEZE_MS, RECONNECT_GAP_MS, PC_HOLD_MS, PC_SHOWN_HOLD_MS } from '../src/js/lib/streamwatch.js';

// Drives a Watch the way the player does: a tick every 250 ms, the playhead moving or not.
function Player(w) {
  let now = 1000000;
  let pos = 0;
  const seen = [];
  const note = (r) => r && seen.push(r);
  return {
    seen: seen,
    now: () => now,
    pos: () => pos,
    play: (ms, pcReading) => {
      for (let t = 0; t < ms; t += 250) {
        now += 250;
        pos += 0.25;
        note(w.tick(now, pos, true, pcReading));
      }
    },
    freeze: (ms, pcReading) => {
      for (let t = 0; t < ms; t += 250) {
        now += 250;
        note(w.tick(now, pos, true, pcReading));
      }
    },
    idle: (ms) => {
      for (let t = 0; t < ms; t += 250) {
        now += 250;
        note(w.tick(now, pos, false, false));
      }
    },
    waiting: (pcReading) => note(w.waiting(now, pos, pcReading)),
    seek: (to) => {
      pos = to;
      w.disrupted(now);
    },
    // One short stall the way the user sees it: a few seconds of film, then the spinner.
    stutter: (playMs, stuckMs, pcReading) => {
      for (let t = 0; t < playMs; t += 250) {
        now += 250;
        pos += 0.25;
        note(w.tick(now, pos, true, pcReading));
      }
      note(w.waiting(now, pos, pcReading));
      for (let t = 0; t < stuckMs; t += 250) {
        now += 250;
        note(w.tick(now, pos, true, pcReading));
      }
    },
  };
}

test('a film that plays smoothly has no stalls', () => {
  const w = Watch();
  const p = Player(w);
  w.disrupted(p.now());
  p.play(600000);
  assert.deepEqual(p.seen, []);
  assert.equal(w.summary(p.now()).stalls, 0);
  assert.equal(w.pcMayRead(p.now(), false), true);
});

test('waiting after a seek is not a stall, however long it takes', () => {
  const w = Watch();
  const p = Player(w);
  w.disrupted(p.now());
  p.play(60000);
  p.seek(900);
  p.waiting();
  p.freeze(SETTLE_MS + 12000); // a slow source: 20 s to start again
  p.play(30000);
  assert.deepEqual(p.seen, []);
  assert.equal(w.summary(p.now()).stalls, 0);
});

test('a stall is counted once, whether the TV says "waiting", the picture stands still, or both', () => {
  const both = Watch();
  const a = Player(both);
  both.disrupted(a.now());
  a.play(60000);
  a.waiting();
  a.freeze(5000);
  a.play(10000);
  assert.deepEqual(a.seen, ['stall']);

  const silent = Watch(); // an engine that sends no "waiting"
  const b = Player(silent);
  silent.disrupted(b.now());
  b.play(60000);
  b.freeze(5000);
  b.play(10000);
  assert.deepEqual(b.seen, ['stall']);
  const s = silent.summary(b.now());
  assert.equal(s.stalls, 1);
  assert.equal(s.stalledMs, 5000 - FREEZE_MS + 250); // from the moment it was noticed until it moved again
  assert.equal(Math.round(s.firstAt), 60);
});

test('"waiting" between two ticks, the playhead a little further on: still one stall', () => {
  const w = Watch();
  w.disrupted(0);
  let now = 0;
  let pos = 0;
  const seen = [];
  const note = (r) => r && seen.push(r);
  for (; now < 60000; now += 250, pos += 0.25) note(w.tick(now, pos, true, false));
  note(w.waiting(now - 100, pos - 0.1, false)); // 150 ms after the last tick
  pos -= 0.1;
  for (let i = 0; i < 40; i++, now += 250) note(w.tick(now, pos, true, false)); // 10 s standing still
  assert.deepEqual(seen, ['stall']);
  assert.equal(w.summary(now).stalls, 1);
});

test('pausing is not a stall', () => {
  const w = Watch();
  const p = Player(w);
  w.disrupted(p.now());
  p.play(60000);
  p.idle(120000);
  p.play(10000);
  assert.deepEqual(p.seen, []);
});

test('stalling every few seconds: reopen once, then say the source is slow, then one last reopen', () => {
  const w = Watch();
  const p = Player(w);
  w.disrupted(p.now());
  p.play(40 * 60000); // fine for 40 minutes
  for (let i = 0; i < 4; i++) p.stutter(3000, 2000);
  assert.deepEqual(p.seen, ['stall', 'stall', 'stall', 'reconnect']);

  // The player reopens the stream: the video is not "active" until it plays again.
  w.disrupted(p.now());
  p.idle(5000);
  w.disrupted(p.now());
  p.play(SETTLE_MS + 1000);

  // Still stalling on the new connection: no second reopen straight away, tell the user once.
  p.seen.length = 0;
  for (let i = 0; i < 8; i++) p.stutter(3000, 2000);
  assert.deepEqual(p.seen, ['stall', 'stall', 'stall', 'slow', 'stall', 'stall', 'stall', 'stall']);

  // Later on, one more try; after that the app leaves the stream alone.
  p.seen.length = 0;
  p.play(RECONNECT_GAP_MS);
  for (let i = 0; i < 4; i++) p.stutter(3000, 2000);
  assert.deepEqual(p.seen, ['stall', 'stall', 'stall', 'reconnect']);
  w.disrupted(p.now());
  p.idle(5000);
  w.disrupted(p.now());
  p.play(RECONNECT_GAP_MS + SETTLE_MS);
  p.seen.length = 0;
  for (let i = 0; i < 6; i++) p.stutter(3000, 2000);
  assert.equal(p.seen.indexOf('reconnect'), -1);
  assert.equal(w.summary(p.now()).reconnects, 2);
});

test('a reopen that helped: the earlier stalls are not held against the new connection', () => {
  const w = Watch();
  const p = Player(w);
  w.disrupted(p.now());
  p.play(60000);
  for (let i = 0; i < 4; i++) p.stutter(3000, 2000);
  w.disrupted(p.now());
  p.idle(5000);
  w.disrupted(p.now());
  p.play(SETTLE_MS + 1000);
  p.seen.length = 0;
  p.stutter(3000, 2000); // one hiccup right after
  assert.deepEqual(p.seen, ['stall']);
});

test('the PC keeps off the file while the TV is short of data', () => {
  const w = Watch();
  const p = Player(w);
  w.disrupted(p.now());
  p.play(60000, true);
  p.waiting(true);
  assert.equal(w.pcMayRead(p.now(), false), false);
  assert.equal(w.pcMayRead(p.now(), true), false); // not even for the subtitle on screen
  p.freeze(3000, false);
  p.play(PC_SHOWN_HOLD_MS + 250, false); // the stall ends on the first tick that moves
  assert.equal(w.pcMayRead(p.now(), true), true); // the one on screen comes back first
  assert.equal(w.pcMayRead(p.now(), false), false);
  p.play(PC_HOLD_MS - PC_SHOWN_HOLD_MS, false);
  assert.equal(w.pcMayRead(p.now(), false), true);
  const s = w.summary(p.now());
  assert.equal(s.pcBusy, 1); // the PC was reading when it stalled
  assert.equal(s.quiet, false);
});

test('three stalls in ten minutes: no more background reading for this video', () => {
  const w = Watch();
  const p = Player(w);
  w.disrupted(p.now());
  for (let i = 0; i < 3; i++) {
    p.play(120000);
    p.waiting();
    p.freeze(2000);
  }
  p.play(30 * 60000);
  assert.equal(w.summary(p.now()).quiet, true);
  assert.equal(w.pcMayRead(p.now(), false), false);
  assert.equal(w.pcMayRead(p.now(), true), true); // a subtitle the viewer turned on still loads
  assert.equal(p.seen.indexOf('reconnect'), -1); // spread out like this it is not worth a reopen
});

test('the wait after a seek does not hold the PC back', () => {
  const w = Watch();
  const p = Player(w);
  w.disrupted(p.now());
  p.play(PC_HOLD_MS);
  p.seek(1200);
  p.waiting();
  assert.equal(w.pcMayRead(p.now(), false), true);
});
