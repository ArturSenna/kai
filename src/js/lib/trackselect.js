// Smart Track Selector: which audio track and which subtitle a video should start with.
// A light port of desktop Kai's smart-track-selector: wanted languages in order, track titles that
// are never picked (signs and songs, commentary), forced tracks, and "forced only" when the audio
// is already in the viewer's language.
// Pure functions over plain track descriptions (languages already canonical, see lib/lang.js), so
// the rules run under `npm test`.
import { words, base } from './lang.js';

// Subtitle titles that are not the dialogue.
const SUB_REJECT = ['sign', 'signs', 'song', 'songs', 'karaoke', 'commentary', 'comentario', 'comentarios', 'credits', 'creditos', 'placas', 'musicas'];
// Forced tracks: only the lines spoken in another language, and on-screen text.
const FORCED = ['forced', 'forcada', 'forcadas', 'forcado', 'forcados', 'foreign'];
// A full-dialogue track, preferred among tracks of the same language.
const FULL = ['full', 'dialogue', 'dialog', 'dialogos', 'complete', 'completa', 'completo'];
// Audio tracks that are not the film's sound.
const AUDIO_REJECT = ['commentary', 'comentario', 'comentarios', 'descriptive', 'description', 'descricao', 'audiodescricao'];

function titled(title, list) {
  return words(title).some((w) => list.indexOf(w) >= 0);
}

export function isForcedSub(track) {
  return !!track.forced || titled(track.title, FORCED);
}

function rejectedSub(track) {
  return !!track.bitmap || titled(track.title, SUB_REJECT) || /\bs\s*&\s*s\b/i.test(track.title || '');
}

// The subtitle to start with.
//   tracks: [{ lang, title, forced, bitmap, source: 'addon' | 'embedded' }]
//   opts.langs: wanted languages, most wanted first
//   opts.preferEmbedded: on a tie in language, the file's own track before an add-on's
//   opts.forcedOnly: base language of the audio when it is already the viewer's language: then only
//     a forced track of that language is picked (and nothing when the file has none)
// Returns { track, rank, order } or null. `order` grows as the match gets worse, so a later
// candidate replaces an earlier pick only when its order is lower.
export function pickSub(tracks, opts) {
  const langs = opts.langs || [];
  let best = null;
  (tracks || []).forEach((track) => {
    if (rejectedSub(track)) return;
    const forced = isForcedSub(track);
    let rank = langs.indexOf(track.lang);
    if (opts.forcedOnly) {
      if (!forced || base(track.lang) !== opts.forcedOnly) return;
      if (rank < 0) rank = langs.length;
    } else if (forced || rank < 0) return;
    const preferredSource = (track.source === 'embedded') === !!opts.preferEmbedded;
    const order = rank * 4 + (preferredSource ? 0 : 2) + (titled(track.title, FULL) ? 0 : 1);
    if (!best || order < best.order) best = { track: track, rank: rank, order: order };
  });
  return best;
}

// The audio track to play: index into tracks ([{ lang, title }]), or -1 to leave the file's choice
// (no wanted language, or none of them in the file). Commentary and audio description never win.
export function pickAudio(tracks, langs) {
  let best = -1;
  let bestRank = Infinity;
  (tracks || []).forEach((track, i) => {
    if (titled(track.title, AUDIO_REJECT)) return;
    const rank = (langs || []).indexOf(track.lang);
    if (rank >= 0 && rank < bestRank) {
      best = i;
      bestRank = rank;
    }
  });
  return best;
}

// Sources whose only sound is a format Samsung TVs don't decode (DTS, TrueHD): they play silent.
// Returns the format's name when the text names one and no playable format next to it, else ''.
export function unplayableAudio(text) {
  const t = String(text || '');
  const bad = /\btrue[\s.-]?hd\b/i.test(t) ? 'TrueHD' : /\bdts(?![a-z])/i.test(t) ? 'DTS' : '';
  if (!bad) return '';
  // A second, playable track is usually named too ("DTS-HD MA 5.1 / DD 5.1", "Dual Audio").
  const playable = /\b(aac|e-?ac-?3|ac-?3|ddp|dd\+?|dolby\s?digital|opus|flac|mp3|dual[\s.-]?audio|multi)\b/i.test(t.replace(/\bdd\+/gi, 'ddp '));
  return playable ? '' : bad;
}
