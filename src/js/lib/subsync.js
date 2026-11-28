// Does a subtitle keep time with this file?
// A subtitle from an add-on was timed against some copy of the film, not necessarily this one: a
// longer studio logo, a different cut or another frame rate and its lines come early or late.
// The app has two things that are certainly in time with the file, both read through the PC's
// Stremio server:
//   - a built-in subtitle track, in any language: lines come and go where people speak;
//   - the sound itself: speech makes the loudness wobble a few times a second, music and noise
//     much less, and in a film's mix voices sit in the middle of the stereo picture.
// Either one gives a line over time ("someone is probably speaking here"). A subtitle is laid over
// it at every shift from -MAX_SHIFT to +MAX_SHIFT seconds; when it belongs to this file, one shift
// stands out sharply from all the others. That shift is how far the subtitle is off.
// Pure arithmetic over plain arrays (no DOM, no network), so it runs under `npm test`.

export const STEP = 0.1; // seconds per point of the lines compared
export const FRAME = 0.02; // seconds per measure of loudness
export const MAX_SHIFT = 60; // seconds a subtitle may be off and still be recognised
const PER = Math.round(STEP / FRAME); // loudness measures per point
const SMOOTH = Math.round(10 / STEP); // the average over ±10 s is taken off: scenes come and go slowly, lines quickly
const NEAR = Math.round(2 / STEP); // shifts this close to the best one are the same peak
const VOICE_RATE = 8000; // samples per second kept from the sound: the voice band

// ---- A subtitle as a line over time ----
// One value per STEP from `from` to `to` (seconds): the part of that step with a subtitle on screen.
export function timeline(cues, from, to) {
  const n = Math.max(0, Math.round((to - from) / STEP));
  const out = new Float32Array(n);
  for (let c = 0; c < cues.length; c++) {
    const s = cues[c].start - from;
    const e = cues[c].end - from;
    if (!(e > s) || e <= 0 || s >= n * STEP) continue;
    const a = Math.max(0, Math.floor(s / STEP));
    const b = Math.min(n - 1, Math.floor(e / STEP));
    for (let i = a; i <= b; i++) {
      const part = Math.min(e, (i + 1) * STEP) - Math.max(s, i * STEP);
      if (part > 0) out[i] = Math.min(1, out[i] + part / STEP);
    }
  }
  return out;
}

// How many of the cues begin between `from` and `to`.
export function cuesWithin(cues, from, to) {
  let n = 0;
  for (let c = 0; c < cues.length; c++) if (cues[c].start >= from && cues[c].start < to) n++;
  return n;
}

// ---- The sound as a line over time ----
// Decoded sound (samples -1..1 at `rate` per second; right is null for mono) reduced to two
// loudness values per FRAME: `mid` is what both speakers play alike (voices), `side` what differs
// between them (most of the music and the surroundings).
export function energies(left, right, rate) {
  const q = Math.max(1, Math.round(rate / VOICE_RATE)); // keep ~8 kHz: every q samples become one
  const frame = Math.max(1, Math.round((FRAME * rate) / q));
  const frames = Math.floor(left.length / q / frame);
  const mid = new Float32Array(frames);
  const side = new Float32Array(frames);
  let pm = 0;
  let ps = 0;
  let at = 0;
  for (let f = 0; f < frames; f++) {
    let em = 0;
    let es = 0;
    for (let k = 0; k < frame; k++) {
      let l = 0;
      let r = 0;
      for (let j = 0; j < q; j++, at++) {
        l += left[at];
        r += right ? right[at] : left[at];
      }
      const m = (l + r) / (2 * q);
      const s = (l - r) / (2 * q);
      const hm = m - 0.95 * pm; // takes the rumble out
      const hs = s - 0.95 * ps;
      pm = m;
      ps = s;
      em += hm * hm;
      es += hs * hs;
    }
    mid[f] = em / frame;
    side[f] = es / frame;
  }
  return { mid: mid, side: side };
}

function dB(x) {
  return 10 * Math.log(x + 1e-9) * Math.LOG10E;
}

// Each value minus the average, in units of the spread (all zeros when nothing varies).
function standard(a) {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    s2 += a[i] * a[i];
  }
  const mean = a.length ? s / a.length : 0;
  const sd = Math.sqrt(Math.max(0, (a.length ? s2 / a.length : 0) - mean * mean));
  const out = new Float32Array(a.length);
  if (sd > 1e-6) for (let i = 0; i < a.length; i++) out[i] = (a[i] - mean) / sd;
  return out;
}

// One value per STEP: how much the stretch sounds like someone speaking.
export function speech(mid, side) {
  const frames = mid.length;
  const n = Math.floor(frames / PER);
  const loud = new Float32Array(frames);
  for (let f = 0; f < frames; f++) loud[f] = dB(mid[f]);
  const wobble = new Float32Array(n); // syllables: the loudness going up and down within half a second
  const centre = new Float32Array(n); // how much more there is in the middle than at the sides
  for (let b = 0; b < n; b++) {
    let em = 0;
    let es = 0;
    for (let k = 0; k < PER; k++) {
      em += mid[b * PER + k];
      es += side[b * PER + k];
    }
    centre[b] = Math.min(30, dB(em / PER) - dB(es / PER));
    const a = Math.max(0, b * PER - 10);
    const z = Math.min(frames, b * PER + PER + 10);
    let s = 0;
    let s2 = 0;
    for (let f = a; f < z; f++) {
      s += loud[f];
      s2 += loud[f] * loud[f];
    }
    wobble[b] = Math.sqrt(Math.max(0, s2 / (z - a) - (s / (z - a)) * (s / (z - a))));
  }
  const w = standard(wobble);
  const c = standard(centre);
  for (let b = 0; b < n; b++) w[b] += c[b];
  return w;
}

// ---- Laying one line over the other ----
function level(a) {
  const out = new Float32Array(a.length);
  const pre = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - SMOOTH);
    const hi = Math.min(a.length, i + SMOOTH + 1);
    out[i] = a[i] - (pre[hi] - pre[lo]) / (hi - lo);
  }
  return out;
}

// A comparison done a few shifts at a time, so a TV's screen never waits on it.
//   ref: the file's own line (from timeline() or speech()), its first value at `from` seconds
//   cues: the subtitle being tested
// step(count) works through `count` more shifts and returns true when all are done; result() then
// gives { shift, r, z, lines }:
//   shift: seconds the subtitle has to be delayed (negative: brought forward) to fit
//   r: how well it fits there (correlation, -1..1)
//   z: how far that fit stands above the fits at all the other shifts, in units of their spread
//   lines: how many of its lines fall in the stretch compared
export function Match(ref, from, cues, maxShift) {
  const L = Math.round((maxShift === undefined ? MAX_SHIFT : maxShift) / STEP);
  const n = ref.length;
  const x = level(ref);
  // The subtitle's line reaches SMOOTH further at each end than is compared, so its ends are
  // levelled like its middle.
  const pad = L + SMOOTH;
  const y = level(timeline(cues, from - pad * STEP, from + (n + pad) * STEP));
  let sx = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sxx += x[i] * x[i];
  }
  const vx = n ? sxx / n - (sx / n) * (sx / n) : 0;
  const py = new Float64Array(y.length + 1);
  const pyy = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) {
    py[i + 1] = py[i] + y[i];
    pyy[i + 1] = pyy[i] + y[i] * y[i];
  }
  const fit = new Float32Array(2 * L + 1);
  let next = -L;

  function one(lag) {
    // ref[i] against the subtitle `lag` steps earlier: the subtitle delayed by `lag`.
    const o = pad - lag;
    let sxy = 0;
    for (let i = 0; i < n; i++) sxy += x[i] * y[o + i];
    const sy = py[o + n] - py[o];
    const syy = pyy[o + n] - pyy[o];
    const vy = syy / n - (sy / n) * (sy / n);
    if (!(vx > 1e-9) || !(vy > 1e-9)) return 0;
    return (sxy / n - (sx / n) * (sy / n)) / Math.sqrt(vx * vy);
  }

  return {
    step: (count) => {
      for (let k = 0; k < count && next <= L; k++, next++) fit[next + L] = n ? one(next) : 0;
      return next > L;
    },
    result: () => {
      let best = 0;
      for (let i = 1; i < fit.length; i++) if (fit[i] > fit[best]) best = i;
      let s = 0;
      let s2 = 0;
      let m = 0;
      for (let i = 0; i < fit.length; i++) {
        if (Math.abs(i - best) <= NEAR) continue;
        s += fit[i];
        s2 += fit[i] * fit[i];
        m++;
      }
      const mean = m ? s / m : 0;
      const sd = Math.sqrt(Math.max(1e-12, (m ? s2 / m : 0) - mean * mean));
      // Between two steps: the top of the curve through the best point and its neighbours.
      let fine = 0;
      if (best > 0 && best < fit.length - 1) {
        const a = fit[best - 1];
        const b = fit[best];
        const c = fit[best + 1];
        const d = a - 2 * b + c;
        if (d < 0) fine = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
      }
      const shift = (best - L + fine) * STEP;
      return {
        shift: Math.round(shift * 20) / 20,
        r: fit[best],
        z: (fit[best] - mean) / sd,
        edge: best === 0 || best === fit.length - 1,
        lines: cuesWithin(cues, from - shift, from + n * STEP - shift),
      };
    },
  };
}

// The whole comparison at once (tests, and anything not on a TV).
export function match(ref, from, cues, maxShift) {
  const m = Match(ref, from, cues, maxShift);
  m.step(Infinity);
  return m.result();
}

// ---- What a comparison means ----
// Measured on two films with their real add-on subtitles (44 files, some timed for another copy)
// and with subtitles that don't belong (another film's, the right lines moved far away), over
// stretches of 3 to 10 minutes:
//   - against a built-in track the right shift stands far above the rest: z of 7 and more, fit of
//     0.54 and more, against z under 5 for the ones that don't belong; and the shift it finds is
//     the right one to within 0.1 s (19 times in 20; never more than 0.5 s off);
//   - against the sound it is fainter: z of 6.4 to 13 where people talk a lot, against 5.9 at most
//     for the ones that don't belong; where music carries the scene, the right subtitle may not
//     stand out at all (z of 3 to 5). So the sound can say "yes", but a "no" from it means little
//     by itself (see lib/synccheck.js). The shift it finds is within 0.2 s of the built-in track's
//     timing on one film and 0.6-0.7 s off it on the other (on every subtitle alike, the file's
//     own included): finer than that, the sound can't tell a late subtitle from a slow speaker.
// inTime: how far off a subtitle may be and still count as in time. Beyond it, the subtitle is
// moved by what was measured.
export const RULES = {
  track: { sure: 6.5, no: 5, fit: 0.3, inTime: 0.2, mid: 5.2, spread: 0.45 },
  sound: { sure: 6.2, no: 4.5, fit: 0.2, inTime: 0.75, mid: 5.3, spread: 0.45 },
};
export const MIN_LINES = 10; // fewer lines than this in the stretch say nothing either way

// How likely the subtitle follows this file at the shift found, 0..1. From the same measurements:
// how far the best shift stands out (z) on a curve that is even (1/2) between the highest z seen
// for a subtitle that doesn't belong and the lowest for one that does, kept down when the fit
// itself is poor (a flat comparison can make a tiny fit stand out), when few lines were compared,
// and when the best shift is at the end of the reach.
export function confidence(res, via) {
  const rule = RULES[via];
  let p = 1 / (1 + Math.exp(-(res.z - rule.mid) / rule.spread));
  p *= Math.max(0, Math.min(1, (res.r - rule.fit / 2) / (rule.fit / 2)));
  if (res.lines < MIN_LINES) p = Math.min(p, 0.5);
  else if (res.lines < 15) p *= 0.85 + (0.15 * (res.lines - MIN_LINES)) / 5;
  if (res.edge) p = Math.min(p, 0.2);
  return p;
}

// 'ok': in time with the file · 'shift': in time once moved by `shift` seconds ·
// 'bad': no shift within reach makes it fit · 'unsure': not enough to go on.
// conf: confidence() of the comparison, so how sure "it fits" is (for 'bad': 1 - conf is how sure
// "it doesn't" is).
export function verdict(res, via) {
  const rule = RULES[via];
  const conf = Math.round(confidence(res, via) * 100) / 100;
  if (res.lines < MIN_LINES) return { state: 'unsure', shift: 0, conf: conf };
  if (res.z >= rule.sure && res.r >= rule.fit && !res.edge) {
    return Math.abs(res.shift) <= rule.inTime ? { state: 'ok', shift: 0, conf: conf } : { state: 'shift', shift: res.shift, conf: conf };
  }
  // Best at the very end of the reach: it is off by more than can be told, or not this film's.
  return { state: res.z < rule.no || res.edge ? 'bad' : 'unsure', shift: 0, conf: conf };
}
