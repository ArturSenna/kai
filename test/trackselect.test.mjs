import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSub, pickAudio, isForcedSub, unplayableAudio } from '../src/js/lib/trackselect.js';

const addon = (lang, extra) => Object.assign({ source: 'addon', lang, title: '' }, extra);
const emb = (lang, title, extra) => Object.assign({ source: 'embedded', lang, title: title || '' }, extra);
const PT = ['pt-br', 'pt'];

test('pickSub: language order decides, wherever the track sits', () => {
  const hit = pickSub([addon('en'), addon('pt'), addon('pt-br')], { langs: PT });
  assert.equal(hit.track.lang, 'pt-br');
  assert.equal(hit.rank, 0);
  assert.equal(pickSub([addon('en')], { langs: PT }), null);
  assert.equal(pickSub([], { langs: PT }), null);
  assert.equal(pickSub([addon('pt-br')], { langs: [] }), null);
});

test('pickSub: second-choice language only when the first has nothing', () => {
  const langs = ['pt-br', 'pt', 'en'];
  assert.equal(pickSub([addon('en'), addon('es')], { langs }).track.lang, 'en');
  assert.equal(pickSub([addon('en'), addon('pt')], { langs }).track.lang, 'pt');
});

test('pickSub: add-on first by default, the file\'s own track when asked', () => {
  const tracks = [addon('pt-br'), emb('pt-br', 'Português (Brasil)')];
  assert.equal(pickSub(tracks, { langs: PT }).track.source, 'addon');
  assert.equal(pickSub(tracks, { langs: PT, preferEmbedded: true }).track.source, 'embedded');
  // The source preference never beats the language.
  assert.equal(pickSub([addon('pt'), emb('pt-br', '')], { langs: PT }).track.source, 'embedded');
});

test('pickSub: signs/songs, commentary, bitmap and forced tracks are never the pick', () => {
  const tracks = [
    emb('pt-br', 'Signs & Songs'),
    emb('pt-br', 'S&S'),
    emb('pt-br', 'Comentário do diretor'),
    emb('pt-br', 'Forçada'),
    emb('pt-br', '', { forced: true }),
    emb('pt-br', 'PGS', { bitmap: true }),
    emb('pt-br', 'Completa'),
  ];
  assert.equal(pickSub(tracks, { langs: PT, preferEmbedded: true }).track.title, 'Completa');
  assert.equal(pickSub(tracks.slice(0, 6), { langs: PT, preferEmbedded: true }), null);
});

test('pickSub: a full-dialogue title wins among tracks of one language', () => {
  const tracks = [emb('en', 'English'), emb('en', 'English [Full Dialogue]'), emb('en', 'English SDH')];
  assert.equal(pickSub(tracks, { langs: ['en'], preferEmbedded: true }).track.title, 'English [Full Dialogue]');
});

test('pickSub: audio already in the viewer\'s language -> forced track only', () => {
  const tracks = [addon('pt-br'), emb('pt-br', 'Português'), emb('pt', 'Forced'), emb('en', 'Forced')];
  const hit = pickSub(tracks, { langs: PT, forcedOnly: 'pt' });
  assert.equal(hit.track.title, 'Forced');
  assert.equal(hit.track.lang, 'pt');
  // No forced track in that language: no subtitles at all.
  assert.equal(pickSub([addon('pt-br'), emb('en', 'Forced')], { langs: PT, forcedOnly: 'pt' }), null);
});

test('pickSub: order lets a later, better candidate replace an earlier pick', () => {
  const first = pickSub([addon('pt')], { langs: PT });
  const later = pickSub([addon('pt'), addon('pt-br')], { langs: PT });
  assert.ok(later.order < first.order);
  const same = pickSub([addon('pt'), addon('pt')], { langs: PT });
  assert.equal(same.order, first.order); // nothing better: keep what is showing
});

test('isForcedSub: flag or title', () => {
  assert.equal(isForcedSub({ forced: true, title: '' }), true);
  assert.equal(isForcedSub({ title: 'Portuguese (Forced)' }), true);
  assert.equal(isForcedSub({ title: 'Legendas forçadas' }), true);
  assert.equal(isForcedSub({ title: 'Reinforced concrete' }), false);
  assert.equal(isForcedSub({ title: '' }), false);
});

test('pickAudio: wanted language, in order; -1 leaves the file alone', () => {
  const tracks = [{ lang: 'en', title: 'English 5.1' }, { lang: 'ja', title: '' }, { lang: 'pt-br', title: 'Dublado' }];
  assert.equal(pickAudio(tracks, ['pt-br', 'pt']), 2);
  assert.equal(pickAudio(tracks, ['ja']), 1);
  assert.equal(pickAudio(tracks, ['ja', 'en']), 1);
  assert.equal(pickAudio(tracks, ['es']), -1);
  assert.equal(pickAudio(tracks, []), -1);
  assert.equal(pickAudio([], ['en']), -1);
  // Generic Portuguese when there is no Brazilian track; the first one on a tie.
  assert.equal(pickAudio([{ lang: 'en', title: '' }, { lang: 'pt', title: '' }, { lang: 'pt', title: '2.0' }], ['pt-br', 'pt']), 1);
});

test('pickAudio: commentary and audio description never win', () => {
  const tracks = [{ lang: 'en', title: '' }, { lang: 'pt-br', title: 'Comentário do diretor' }, { lang: 'pt-br', title: 'Audiodescrição' }, { lang: 'pt', title: 'Português' }];
  assert.equal(pickAudio(tracks, ['pt-br', 'pt']), 3);
});

test('unplayableAudio: DTS / TrueHD with nothing playable next to it', () => {
  assert.equal(unplayableAudio('Movie.2020.1080p.BluRay.DTS.x264'), 'DTS');
  assert.equal(unplayableAudio('Movie 2160p UHD BluRay REMUX HDR HEVC DTS-HD MA 7.1'), 'DTS');
  assert.equal(unplayableAudio('Movie.2160p.TrueHD.7.1.Atmos'), 'TrueHD');
  assert.equal(unplayableAudio('Movie 1080p DTS:X'), 'DTS');
  assert.equal(unplayableAudio('Movie.1080p.BluRay.DTS-HD.MA.5.1 / DD 5.1'), '');
  assert.equal(unplayableAudio('Movie.1080p.WEB-DL.DDP5.1.Atmos'), '');
  assert.equal(unplayableAudio('Movie 1080p DD+ 5.1'), '');
  assert.equal(unplayableAudio('Movie.1080p.DTS.Dual.Audio'), '');
  assert.equal(unplayableAudio('Movie.720p.HDTS.x264.AAC'), ''); // HDTS is a cam rip, not DTS sound
  assert.equal(unplayableAudio('Movie.720p.HDTS.x264'), '');
  assert.equal(unplayableAudio(''), '');
  assert.equal(unplayableAudio(null), '');
});
