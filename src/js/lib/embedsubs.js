// A built-in (MKV) subtitle track pulled from the PC's Stremio server as text.
// The server hands a track out in 10-second blocks. Asking for the first block makes it open the
// file and seek, which takes several seconds on a remote file; from then on it keeps reading the
// file ahead at full speed, so the following blocks come almost at once. Two consequences:
//   - loading has to start before the text is needed (the player starts it in the background);
//   - left alone, the server would download the rest of the film next to the TV's own stream, so
//     this loader lets it run only a few minutes ahead of the playhead, then tells it to stop.
// No DOM and no network of its own (both are passed in), so the pacing runs under `npm test`.

export const BLOCK = 10; // seconds of subtitles per block
const AHEAD_MAX = 30; // stop the server once this many blocks past the playhead are in (5 min)
const AHEAD_MIN = 6; // ask it to start again when fewer than this many are left (1 min)
const MAX_FAILS = 3;

// o.blockUrl(session, k): address of block k        o.stopUrl(session): tells the server to stop reading
// o.getText(url) -> Promise<string>                 o.parse(text) -> [{ start, end, text }]
// o.newSession() -> a fresh id for the server       o.onChange(), o.onFail(): what happened
export function Loader(o) {
  let session = o.newSession();
  const have = {}; // block number -> loaded
  const seen = {}; // cue key -> already in `cues` (blocks overlap by a line now and then)
  let cues = [];
  let busy = false;
  let reading = false; // the server is (as far as we know) reading the file for this session
  let last = 0; // last block received in this session
  let fails = 0;
  let failed = false;
  let stopped = false;
  let restAfter = false; // rest() came in the middle of a block: let go once that block is in

  function blockAt(time) {
    return Math.floor(Math.max(0, time) / BLOCK) + 1;
  }

  // Ends the server's read of the file; the next block asked for starts a new one.
  function release() {
    if (!reading) return;
    reading = false;
    last = 0;
    o.getText(o.stopUrl(session)).catch(() => {});
    session = o.newSession();
  }

  function fetchBlock(k) {
    busy = true;
    reading = true;
    o.getText(o.blockUrl(session, k))
      .then(
        (text) => {
          have[k] = true;
          last = k;
          fails = 0;
          o.parse(text).forEach((c) => {
            const key = c.start + '|' + c.text;
            if (seen[key]) return;
            seen[key] = true;
            cues.push(c);
          });
          cues.sort((a, b) => a.start - b.start);
          busy = false;
          if (restAfter) rest();
          if (!stopped) o.onChange();
        },
        () => {
          busy = false;
          if (restAfter) return rest(); // the line was busy with the video: not the server's fault
          if (stopped || ++fails < MAX_FAILS) return;
          failed = true;
          release();
          o.onFail();
        }
      );
  }

  // Lets the server go for now; want() starts it again. A block on its way is waited for, so that
  // cutting it short is not taken for the server failing to read the track.
  function rest() {
    restAfter = busy;
    if (!busy) release();
  }

  return {
    // Call often with the playhead (seconds): fetches what is missing, one block at a time.
    want: (time) => {
      restAfter = false;
      if (stopped || failed || busy) return;
      const n = blockAt(time);
      let missing = 0;
      for (let k = n; k <= n + AHEAD_MAX && !missing; k++) if (!have[k]) missing = k;
      if (!missing) return release(); // the next minutes are in: the server can rest
      if (!reading && missing > n + AHEAD_MIN) return; // still enough ahead
      if (reading && last && missing !== last + 1) release(); // the playhead jumped: read from there
      fetchBlock(missing);
    },
    // The text for this moment is in (an empty block counts: nobody speaks).
    covers: (time) => !!have[blockAt(time)],
    cues: () => cues,
    failed: () => failed,
    // The video itself is short of data: the server stops reading the file until want() is called again.
    rest: rest,
    // The server is reading the file for this track right now.
    reading: () => reading,
    stop: () => {
      stopped = true;
      release();
    },
  };
}
