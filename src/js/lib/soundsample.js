// A few minutes of the film's sound, fetched from the PC's Stremio server and boiled down to
// loudness values (lib/subsync.js compares subtitles against them).
// The TV plays the film through its own decoder and never lets a web page hear it. The PC server
// can hand out any audio track as a list of short AAC pieces (about 4 seconds each, the same ones
// it would serve for converted playback); the app fetches the pieces of the stretch it wants, has
// the browser decode each one, and keeps only two numbers per 20 ms of it.
// As with built-in subtitles (lib/embedsubs.js), once asked for a piece the server keeps reading
// the file ahead at full speed, next to the TV's own stream: so the pieces are fetched in order,
// the server is told to stop as soon as the stretch is in, and rest() lets go of it at once when
// the video itself is short of data.
// No DOM and no network of its own (both are passed in), so the pacing runs under `npm test`.
import { energies, FRAME } from './subsync.js';

const MAX_FAILS = 3;

// The server's list of pieces: { init, parts: [{ uri, start, end }] } (seconds from the film's start).
export function parsePlaylist(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = { init: '', parts: [] };
  let at = 0;
  let dur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const map = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/);
    if (map) out.init = map[1];
    const inf = line.match(/^#EXTINF:([\d.]+)/);
    if (inf) dur = parseFloat(inf[1]);
    if (line.charAt(0) === '#' || dur === null) continue;
    out.parts.push({ uri: line, start: at, end: at + dur });
    at += dur;
    dur = null;
  }
  return out;
}

function join(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer;
}

// o.from, o.seconds: the stretch wanted (seconds of film)
// o.newSession() -> a fresh id for the server      o.listUrl(session): the list of pieces
// o.fileUrl(session, uri): a piece named in the list      o.stopUrl(session): tells the server to stop reading
// o.getText(url) -> Promise<string>                o.getBytes(url) -> Promise<ArrayBuffer>
// o.decode(bytes) -> Promise<{ left, right, rate }> (samples; right is null for mono)
// o.onDone({ from, to, mid, side }): the stretch as the server's pieces cut it
// o.onFail(reason): 'server' (it didn't answer) or 'decode' (this device can't decode the pieces)
export function Sampler(o) {
  let session = o.newSession();
  let list = null; // the pieces of the stretch
  let init = null; // the header every piece needs in front of it: its name, then its bytes
  let next = 0; // index into list of the next piece to fetch
  let from = 0;
  let to = 0;
  let mid = null;
  let side = null;
  let filled = null;
  let busy = false;
  let reading = false; // the server is (as far as we know) reading the file for this session
  let fails = 0;
  let over = false; // done, failed or stopped
  let restAfter = false; // rest() came in the middle of a request: let go once it is answered

  function release() {
    if (!reading) return;
    reading = false;
    o.getText(o.stopUrl(session)).catch(() => {});
    session = o.newSession();
  }

  // Lets the server go for now; go() starts it again where it stopped.
  function rest() {
    restAfter = busy;
    if (!busy) release();
  }

  function fail(reason) {
    if (over) return;
    over = true;
    release();
    o.onFail(reason);
  }

  function refused(reason) {
    busy = false;
    if (over) return;
    if (restAfter) return rest(); // the line was busy with the video: not the server's fault
    if (++fails >= MAX_FAILS) fail(reason);
  }

  function finish() {
    // The server cuts on whole AAC frames, so a piece can come a frame short: such a gap repeats
    // the value before it.
    for (let i = 1; i < filled.length; i++) {
      if (filled[i]) continue;
      mid[i] = mid[i - 1];
      side[i] = side[i - 1];
    }
    over = true;
    release();
    o.onDone({ from: from, to: to, mid: mid, side: side });
  }

  function keep(part, sound) {
    const e = energies(sound.left, sound.right, sound.rate);
    const at = Math.round((part.start - from) / FRAME);
    // No more than the piece's own length: a decoder may add a little at the end.
    const count = Math.min(e.mid.length, Math.round((part.end - part.start) / FRAME) + 1, mid.length - at);
    for (let i = 0; i < count; i++) {
      mid[at + i] = e.mid[i];
      side[at + i] = e.side[i];
      filled[at + i] = 1;
    }
  }

  function readList(text) {
    const pl = parsePlaylist(text);
    const want = pl.parts.filter((p) => p.end > o.from && p.start < o.from + o.seconds);
    if (!pl.init || !want.length) return fail('server');
    list = want;
    init = pl.init;
    from = want[0].start;
    to = want[want.length - 1].end;
    const frames = Math.round((to - from) / FRAME);
    mid = new Float32Array(frames);
    side = new Float32Array(frames);
    filled = new Uint8Array(frames);
  }

  function decoded(part, sound) {
    busy = false;
    if (over) return;
    fails = 0;
    keep(part, sound);
    next++;
    if (next >= list.length) return finish();
    if (restAfter) rest();
  }

  function ask(url, how, then) {
    busy = true;
    how(url).then(
      (answer) => {
        if (over) return (busy = false);
        then(answer);
      },
      () => refused('server')
    );
  }

  return {
    // Call often while the PC may read the file: takes the next step, one request at a time.
    go: () => {
      restAfter = false;
      if (over || busy) return;
      if (!list) {
        return ask(o.listUrl(session), o.getText, (text) => {
          busy = false;
          fails = 0;
          readList(text);
        });
      }
      reading = true;
      if (typeof init === 'string') {
        return ask(o.fileUrl(session, init), o.getBytes, (bytes) => {
          busy = false;
          fails = 0;
          init = bytes;
          if (restAfter) rest();
        });
      }
      const part = list[next];
      ask(o.fileUrl(session, part.uri), o.getBytes, (bytes) => {
        o.decode(join(init, bytes)).then(
          (sound) => decoded(part, sound),
          // The first piece of all tells whether this device can decode them at all.
          () => (next === 0 ? ((busy = false), fail('decode')) : refused('decode'))
        );
      });
    },
    // The video itself is short of data: the server stops reading the file until go() is called again.
    rest: rest,
    // The server is reading the file for this right now.
    reading: () => reading,
    // How far along, 0..1.
    progress: () => (list ? next / list.length : 0),
    stop: () => {
      over = true;
      release();
    },
  };
}
