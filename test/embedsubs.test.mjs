import test from 'node:test';
import assert from 'node:assert/strict';
import { Loader, BLOCK } from '../src/js/lib/embedsubs.js';

// A stand-in for the server: every request waits until the test lets it answer.
function rig(opts) {
  const calls = []; // { url, resolve, reject }
  let sessions = 0;
  const events = [];
  const loader = Loader({
    newSession: () => 's' + ++sessions,
    blockUrl: (s, k) => s + '/block' + k,
    stopUrl: (s) => s + '/stop',
    getText: (url) => new Promise((resolve, reject) => calls.push({ url, resolve, reject })),
    parse: (text) => (text ? [{ start: Number(text), end: Number(text) + 2, text: 'line ' + text }] : []),
    onChange: () => events.push('change'),
    onFail: () => events.push('fail'),
    ...opts,
  });
  const pending = () => calls.filter((c) => !c.done);
  const answer = async (text) => {
    const c = pending().find((x) => !/stop$/.test(x.url));
    c.done = true;
    c.resolve(text);
    await Promise.resolve();
    await Promise.resolve();
  };
  const refuse = async () => {
    const c = pending().find((x) => !/stop$/.test(x.url));
    c.done = true;
    c.reject(new Error('no'));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { loader, calls, events, answer, refuse, urls: () => calls.map((c) => c.url) };
}

test('asks for the block under the playhead first, one block at a time, in order', async () => {
  const r = rig();
  r.loader.want(605); // block 61
  r.loader.want(605); // still waiting: nothing new is asked
  assert.deepEqual(r.urls(), ['s1/block61']);
  assert.equal(r.loader.covers(605), false);
  await r.answer('601');
  assert.equal(r.loader.covers(605), true);
  assert.deepEqual(r.loader.cues(), [{ start: 601, end: 603, text: 'line 601' }]);
  r.loader.want(606);
  assert.deepEqual(r.urls(), ['s1/block61', 's1/block62']);
  assert.deepEqual(r.events, ['change']);
});

test('an empty block still counts as loaded', async () => {
  const r = rig();
  r.loader.want(0);
  await r.answer('');
  assert.equal(r.loader.covers(3), true);
  assert.deepEqual(r.loader.cues(), []);
});

test('stops the server five minutes ahead and starts again when one minute is left', async () => {
  const r = rig();
  let asked = 0;
  for (let i = 0; i < 60; i++) {
    r.loader.want(0);
    if (r.urls().length === asked) break;
    asked = r.urls().length;
    if (/stop$/.test(r.urls()[asked - 1])) break;
    await r.answer(String(i * BLOCK));
  }
  const urls = r.urls();
  assert.equal(urls.filter((u) => /block/.test(u)).length, 31); // blocks 1..31: the playhead's and 30 ahead
  assert.equal(urls[urls.length - 1], 's1/stop');
  r.loader.want(200); // block 21: 10 blocks still ahead
  assert.equal(r.urls().length, urls.length, 'nothing asked while enough is ahead');
  r.loader.want(255); // block 26: only 5 left
  assert.equal(r.urls()[r.urls().length - 1], 's2/block32'); // a new session, from the first block missing
});

test('a jump of the playhead restarts the server at the new place', async () => {
  const r = rig();
  r.loader.want(0);
  await r.answer('0');
  r.loader.want(1);
  await r.answer('10');
  r.loader.want(1200); // block 121, far from block 2
  assert.deepEqual(r.urls().slice(-2), ['s1/stop', 's2/block121']);
  await r.answer('1200');
  r.loader.want(5); // back to the start: blocks 1 and 2 are still in, 3 is next
  assert.deepEqual(r.urls().slice(-2), ['s2/stop', 's3/block3']);
  assert.equal(r.loader.covers(5), true);
});

test('lines repeated across blocks are kept once, in time order', async () => {
  const r = rig({ parse: (text) => text.split(',').map((s) => ({ start: Number(s), end: Number(s) + 2, text: 'l' + s })) });
  r.loader.want(0);
  await r.answer('8,2');
  r.loader.want(0);
  await r.answer('8,12');
  assert.deepEqual(r.loader.cues().map((c) => c.start), [2, 8, 12]);
});

test('gives up after three failures in a row, not before', async () => {
  const r = rig();
  r.loader.want(0);
  await r.refuse();
  r.loader.want(0);
  await r.refuse();
  assert.equal(r.loader.failed(), false);
  r.loader.want(0);
  await r.answer('0'); // a success in between resets the count
  for (let i = 0; i < 3; i++) {
    r.loader.want(0);
    await r.refuse();
  }
  assert.equal(r.loader.failed(), true);
  assert.deepEqual(r.events, ['change', 'fail']);
  const before = r.urls().length;
  r.loader.want(0);
  assert.equal(r.urls().length, before, 'a failed track asks for nothing more');
});

test('stop() releases the server and silences late answers', async () => {
  const r = rig();
  r.loader.want(0);
  r.loader.stop();
  assert.equal(r.urls()[r.urls().length - 1], 's1/stop');
  await r.answer('0');
  assert.deepEqual(r.events, []);
  r.loader.want(0);
  assert.equal(r.urls().filter((u) => /block/.test(u)).length, 1);
});

test('rest: the server stops reading at once when idle, and want() starts it again where it left off', async () => {
  const r = rig();
  r.loader.want(0);
  await r.answer('1');
  assert.equal(r.loader.reading(), true);
  r.loader.rest();
  r.loader.rest(); // asked again every tick: one stop only
  assert.equal(r.loader.reading(), false);
  assert.deepEqual(r.urls(), ['s1/block1', 's1/stop']);
  r.loader.want(5);
  assert.deepEqual(r.urls(), ['s1/block1', 's1/stop', 's2/block2']);
  assert.deepEqual(r.events, ['change']);
});

test('rest in the middle of a block waits for it, and never counts as the server failing', async () => {
  const r = rig();
  r.loader.want(0);
  r.loader.rest(); // block 1 is on its way
  assert.deepEqual(r.urls(), ['s1/block1']);
  await r.answer('1');
  assert.deepEqual(r.urls(), ['s1/block1', 's1/stop']);
  assert.equal(r.loader.covers(3), true);
  // The same, many times over, with blocks that fail: still not a failed track.
  for (let i = 0; i < 5; i++) {
    r.loader.want(0);
    r.loader.rest();
    await r.refuse();
  }
  assert.equal(r.loader.failed(), false);
  assert.equal(r.events.indexOf('fail'), -1);
});

test('rest taken back before the block is in: the server keeps reading', async () => {
  const r = rig();
  r.loader.want(0);
  r.loader.rest();
  r.loader.want(0); // the video is fine again
  await r.answer('1');
  assert.equal(r.loader.reading(), true);
  assert.deepEqual(r.urls(), ['s1/block1']);
});
