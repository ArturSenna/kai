// Watches a playing video for the moments it runs out of data, and says what the player should do.
// The TV fetches the video by itself (a plain <video> on the file's address), so the app cannot
// steer the download. What it can do when the stream stops keeping up:
//   - reopen it: a connection that went slow part-way through a film often comes back at full
//     speed as a new one (what leaving the film and resuming does by hand);
//   - keep the PC off the file: reading the built-in subtitles there (lib/embedsubs.js) downloads
//     the same film from the same host at the same time.
// A stall is the video standing still while it should be playing. Waiting right after a seek, a
// start or a track switch is expected and not counted.
// No DOM and no clock of its own (times are passed in, in ms), so it runs under `npm test`.

export const SETTLE_MS = 8000; // after a seek/start/track switch, waiting is normal for this long
export const FREEZE_MS = 1500; // the picture standing still this long is a stall, event or no event
export const WINDOW_MS = 90000;
export const THRASH = 4; // stalls within WINDOW_MS: the stream is no longer keeping up
export const RECONNECT_GAP_MS = 180000; // at most one reopen in this long
export const MAX_RECONNECTS = 2; // per video
export const PC_HOLD_MS = 60000; // background reading on the PC stays off this long after a stall
export const PC_SHOWN_HOLD_MS = 10000; // ...and this long for the subtitle that is on screen
export const PC_QUIET_WINDOW_MS = 600000;
export const PC_QUIET_AFTER = 3; // stalls within PC_QUIET_WINDOW_MS: no more background reading for this video

export function Watch() {
  let settledAt = -Infinity;
  let lastPos = -1;
  let lastMove = 0;
  let inStall = false;
  let counted = false; // the current stall is a real one (not the wait after a seek)
  let stallStart = 0;
  let lastStallEnd = -Infinity;
  let recent = []; // start times of the stalls since the last reopen, within WINDOW_MS
  let lately = []; // start times within PC_QUIET_WINDOW_MS
  let reconnects = 0;
  let lastReconnect = -Infinity;
  let told = false;
  let quiet = false;
  const sum = { stalls: 0, stalledMs: 0, firstAt: null, lastAt: null, reconnects: 0, pcBusy: 0 };

  function begin(now, pos, pcReading) {
    if (inStall) return '';
    inStall = true;
    counted = now - settledAt >= SETTLE_MS;
    if (!counted) return '';
    stallStart = now;
    sum.stalls++;
    if (sum.firstAt === null) sum.firstAt = pos;
    sum.lastAt = pos;
    if (pcReading) sum.pcBusy++;
    recent = recent.filter((t) => now - t <= WINDOW_MS).concat(now);
    lately = lately.filter((t) => now - t <= PC_QUIET_WINDOW_MS).concat(now);
    if (lately.length >= PC_QUIET_AFTER) quiet = true;
    if (recent.length < THRASH) return 'stall';
    if (reconnects < MAX_RECONNECTS && now - lastReconnect >= RECONNECT_GAP_MS) {
      reconnects++;
      sum.reconnects = reconnects;
      lastReconnect = now;
      recent = []; // the new connection is judged on its own
      return 'reconnect';
    }
    // Reopening didn't help (or was done twice already): say so, once.
    if (!told) {
      told = true;
      return 'slow';
    }
    return 'stall';
  }

  function end(now) {
    if (!inStall) return;
    inStall = false;
    if (!counted) return;
    sum.stalledMs += now - stallStart;
    lastStallEnd = now;
  }

  return {
    // Something that makes the video wait for a good reason: start, seek, reopen, audio switch.
    disrupted: (now) => {
      settledAt = now;
    },
    // Call a few times a second. pos: the playhead (s). active: the video should be moving
    // (started, not paused, not seeking, not over). Returns '', 'stall', 'reconnect' or 'slow'.
    tick: (now, pos, active, pcReading) => {
      if (!active) {
        end(now);
        lastPos = pos;
        lastMove = now;
        return '';
      }
      if (Math.abs(pos - lastPos) > 0.05) {
        lastPos = pos;
        lastMove = now;
        end(now);
        return '';
      }
      if (!inStall && now - lastMove >= FREEZE_MS) return begin(now, pos, pcReading);
      return '';
    },
    // The video's own "waiting" event, while it should be moving. Same answers as tick().
    // The playhead as it is now is where it stopped: what it covered since the last tick() is not
    // taken for the video moving again (the same stall would be counted twice).
    waiting: (now, pos, pcReading) => {
      lastPos = pos;
      lastMove = now;
      return begin(now, pos, pcReading);
    },
    // May the PC read the file now? shown: for the subtitle that is on screen.
    pcMayRead: (now, shown) => {
      if (inStall && counted) return false;
      if (shown) return now - lastStallEnd >= PC_SHOWN_HOLD_MS;
      return !quiet && now - lastStallEnd >= PC_HOLD_MS;
    },
    // For the diagnostics screen. Positions are in seconds of video.
    summary: (now) => ({
      stalls: sum.stalls,
      stalledMs: sum.stalledMs + (inStall && counted ? now - stallStart : 0),
      firstAt: sum.firstAt,
      lastAt: sum.lastAt,
      reconnects: sum.reconnects,
      pcBusy: sum.pcBusy,
      quiet: quiet,
    }),
  };
}
