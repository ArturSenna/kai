import test from 'node:test';
import assert from 'node:assert/strict';
import { Sampler, parsePlaylist } from '../src/js/lib/soundsample.js';
import { FRAME } from '../src/js/lib/subsync.js';

const PIECE = 4; // seconds per piece in these tests
const RATE = 8000;

function playlist(pieces) {
  let text = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXT-X-MAP:URI="audio0/init.mp4?mediaURL=x"\n';
  for (let k = 1; k <= pieces; k++) text += '#EXTINF:' + PIECE.toFixed(6) + ',\naudio0/segment' + k + '.m4s?mediaURL=x\n';
  return text + '#EXT-X-ENDLIST\n';
}

// A stand-in for the server and the decoder: every request waits until the test lets it answer.
// A piece's "sound" is a steady level equal to its number, so where it landed can be read back.
function rig(opts) {
  const calls = []; // { url, resolve, reject, done }
  let sessions = 0;
  const events = [];
  const net = (url) => new Promise((resolve, reject) => calls.push({ url, resolve, reject }));
  const sampler = Sampler({
    from: 20,
    seconds: 12,
    newSession: () => 's' + ++sessions,
    listUrl: (s) => s + '/list',
    fileUrl: (s, uri) => s + '/' + uri.split('?')[0],
    stopUrl: (s) => s + '/stop',
    getText: net,
    getBytes: net,
    decode: (bytes) => {
      const piece = new Uint8Array(bytes)[1]; // the test's "piece" is one byte after the header's one
      if (opts && opts.undecodable && opts.undecodable(piece)) return Promise.reject(new Error('no'));
      const n = Math.round(PIECE * RATE) - (opts && opts.short ? 200 : 0);
      return Promise.resolve({ left: new Float32Array(n).fill(piece / 100), right: null, rate: RATE });
    },
    onDone: (s) => events.push(s),
    onFail: (r) => events.push('fail:' + r),
  });
  const open = () => calls.filter((c) => !c.done && !/stop$/.test(c.url));
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const answer = async () => {
    const c = open()[0];
    c.done = true;
    if (/list$/.test(c.url)) c.resolve(playlist(20));
    else if (/init\.mp4$/.test(c.url)) c.resolve(new Uint8Array([0]).buffer);
    else c.resolve(new Uint8Array([Number(c.url.match(/segment(\d+)/)[1])]).buffer);
    await settle();
  };
  const refuse = async () => {
    const c = open()[0];
    c.done = true;
    c.reject(new Error('no'));
    await settle();
  };
  return { sampler, calls, events, answer, refuse, open, urls: () => calls.map((c) => c.url) };
}

test("the server's list of pieces is read with where each one sits in the film", () => {
  const pl = parsePlaylist(playlist(3));
  assert.equal(pl.init, 'audio0/init.mp4?mediaURL=x');
  assert.deepEqual(pl.parts, [
    { uri: 'audio0/segment1.m4s?mediaURL=x', start: 0, end: 4 },
    { uri: 'audio0/segment2.m4s?mediaURL=x', start: 4, end: 8 },
    { uri: 'audio0/segment3.m4s?mediaURL=x', start: 8, end: 12 },
  ]);
  assert.deepEqual(parsePlaylist('nothing here'), { init: '', parts: [] });
});

test('asks for the list, the header, then only the pieces of the stretch, in order, and tells the server to stop', async () => {
  const r = rig();
  r.sampler.go();
  r.sampler.go(); // one request at a time
  assert.deepEqual(r.urls(), ['s1/list']);
  assert.equal(r.sampler.reading(), false); // a list is not the file being read
  await r.answer();
  r.sampler.go();
  assert.deepEqual(r.urls(), ['s1/list', 's1/audio0/init.mp4']);
  await r.answer();
  // 20 s to 32 s of film: pieces 6, 7 and 8 (20-24, 24-28, 28-32).
  for (const k of [6, 7, 8]) {
    r.sampler.go();
    assert.equal(r.urls().pop(), 's1/audio0/segment' + k + '.m4s');
    assert.equal(r.sampler.reading(), true);
    await r.answer();
  }
  assert.equal(r.urls().pop(), 's1/stop');
  assert.equal(r.sampler.reading(), false);
  assert.equal(r.events.length, 1);
  const s = r.events[0];
  assert.equal(s.from, 20);
  assert.equal(s.to, 32);
  assert.equal(s.mid.length, Math.round(12 / FRAME));
  r.sampler.go(); // nothing more to ask
  assert.equal(r.open().length, 0);
});

test("each piece's loudness lands at its place in the stretch", async () => {
  const r = rig();
  for (let i = 0; i < 5; i++) {
    r.sampler.go();
    await r.answer();
  }
  const s = r.events[0];
  const per = Math.round(PIECE / FRAME);
  // Louder pieces further on: 6, 7, 8 (a level's energy goes with its square; the first measure
  // of a piece still carries the step from the one before).
  const level = (i) => s.mid[i * per + 20];
  assert.ok(level(0) > 0);
  assert.ok(level(1) > level(0) * 1.2);
  assert.ok(level(2) > level(1) * 1.2);
  assert.ok(Math.abs(s.mid[per - 5] - level(0)) < level(0) * 0.01);
});

test('a piece that comes a little short leaves no hole', async () => {
  const r = rig({ short: true });
  for (let i = 0; i < 5; i++) {
    r.sampler.go();
    await r.answer();
  }
  const s = r.events[0];
  for (let i = 0; i < s.mid.length; i++) assert.ok(s.mid[i] > 0, 'hole at ' + i);
});

test('rest() lets the server go at once, and go() carries on with a new session where it stopped', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) {
    r.sampler.go();
    await r.answer();
  }
  assert.equal(r.urls().pop(), 's1/audio0/segment6.m4s');
  r.sampler.rest();
  assert.equal(r.urls().pop(), 's1/stop');
  assert.equal(r.sampler.reading(), false);
  r.sampler.go();
  assert.equal(r.urls().pop(), 's2/audio0/segment7.m4s'); // header and piece 6 are not asked again
});

test('rest() in the middle of a request waits for its answer, and a request cut short is not a failure', async () => {
  const r = rig();
  for (let i = 0; i < 2; i++) {
    r.sampler.go();
    await r.answer();
  }
  r.sampler.go(); // piece 6 on its way
  r.sampler.rest();
  assert.ok(!r.urls().some((u) => /stop$/.test(u)));
  await r.answer();
  assert.equal(r.urls().pop(), 's1/stop');
  // Three requests cut short by the video needing the line: still no failure.
  for (let i = 0; i < 3; i++) {
    r.sampler.go();
    r.sampler.rest();
    await r.refuse();
  }
  assert.equal(r.events.length, 0);
  r.sampler.go();
  assert.match(r.urls().pop(), /segment7\.m4s$/);
});

test('the server not answering three times in a row ends it', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) {
    r.sampler.go();
    await r.refuse();
  }
  assert.deepEqual(r.events, ['fail:server']);
  r.sampler.go();
  assert.equal(r.open().length, 0);
});

test("a device that can't decode the first piece ends it at once, with the reason", async () => {
  const r = rig({ undecodable: () => true });
  for (let i = 0; i < 3; i++) {
    r.sampler.go();
    await r.answer();
  }
  assert.deepEqual(r.events, ['fail:decode']);
  assert.equal(r.urls().pop(), 's1/stop');
});

test('one bad piece later on is asked for again', async () => {
  let tries = 0;
  const r = rig({ undecodable: (piece) => piece === 7 && ++tries === 1 });
  for (let i = 0; i < 4; i++) {
    r.sampler.go();
    await r.answer();
  }
  assert.match(r.urls().pop(), /segment7\.m4s$/);
  r.sampler.go();
  assert.match(r.urls().pop(), /segment7\.m4s$/);
  await r.answer();
  r.sampler.go();
  await r.answer();
  assert.equal(r.events.length, 1);
  assert.equal(typeof r.events[0], 'object');
});

test('stop() ends it quietly', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) {
    r.sampler.go();
    await r.answer();
  }
  r.sampler.go();
  r.sampler.stop();
  assert.equal(r.urls().pop(), 's1/stop');
  await r.answer(); // the piece that was on its way
  r.sampler.go();
  assert.equal(r.open().length, 0);
  assert.equal(r.events.length, 0);
});
