import test from 'node:test';
import assert from 'node:assert/strict';
import { fileIdent, canProbe, dialogueTracks, langTags, compact, expand, Queue } from '../src/js/lib/sourcesubs.js';

test('a file is known by its name, never by its address', () => {
  assert.equal(fileIdent({ url: 'https://x/resolve/realdebrid/KEY/abc', behaviorHints: { filename: 'Film.2010.1080p.mkv' } }, 'tt1'), 'tt1|Film.2010.1080p.mkv');
  assert.equal(fileIdent({ infoHash: 'abc', fileIdx: 2 }, 'tt1'), 'tt1|abc:2');
  assert.equal(fileIdent({ url: 'https://host/d/KEY/Film.mkv?token=1' }, 'tt1'), 'tt1|Film.mkv');
  assert.equal(fileIdent({ url: 'https://host/resolve/KEY/abc' }, 'tt1'), '');
});

test('only ready direct links are read: no torrents, no debrid links still downloading', () => {
  assert.equal(canProbe({ name: '[RD+] Torrentio\n1080p', url: 'https://torrentio/resolve/realdebrid/k/h/null/0/f.mkv' }), true);
  assert.equal(canProbe({ name: 'Plain', url: 'http://192.168.1.2/film.mkv' }), true);
  assert.equal(canProbe({ name: '[RD download] Torrentio\n1080p', url: 'https://torrentio/resolve/x' }), false);
  assert.equal(canProbe({ name: 'AIO ⏳ 1080p', url: 'https://aio/playback/x' }), false);
  assert.equal(canProbe({ name: 'Torrentio', infoHash: 'abc', fileIdx: 0 }), false);
  assert.equal(canProbe({ name: 'x', url: 'magnet:?xt=urn:btih:abc' }), false);
  assert.equal(canProbe({ name: 'x', url: 'https://h/f.mkv', behaviorHints: { proxyHeaders: { request: { a: 'b' } } } }), false);
  assert.equal(canProbe({ name: 'x', ytId: 'abc' }), false);
});

const FILE = {
  audio: [{ lang: 'eng', label: 'English 5.1', codec: 'ac3' }],
  subs: [
    { lang: 'por', label: 'Forced', codec: 'subrip' }, // forced: not the dialogue
    { lang: 'por', label: 'Brazilian', codec: 'subrip' }, // Brazilian Portuguese as files tag it
    { lang: 'eng', label: 'Signs & Songs', codec: 'ass' }, // not the dialogue
    { lang: 'spa', label: '', codec: 'hdmv_pgs_subtitle' }, // a picture track: the app can't show it
    { lang: 'spa', label: 'Latino', codec: 'subrip' },
  ],
};

test("a file's dialogue tracks: no forced, signs-and-songs or picture tracks", () => {
  assert.deepEqual(
    dialogueTracks(FILE).map((x) => [x.index, x.lang]),
    [
      [1, 'pt-br'],
      [4, 'es'],
    ]
  );
  assert.deepEqual(dialogueTracks(null), []);
});

test('the marks: the best first-choice and second-choice language the file has', () => {
  assert.deepEqual(langTags(FILE, ['pt-br', 'pt'], ['en']), { primary: 'pt-br', secondary: '' });
  assert.deepEqual(langTags(FILE, ['en'], ['es']), { primary: '', secondary: 'es' });
  // Generic Portuguese still counts for a Brazilian first choice, as itself.
  const plain = { subs: [{ lang: 'por', label: '', codec: 'subrip' }, { lang: 'eng', label: 'English', codec: 'subrip' }] };
  assert.deepEqual(langTags(plain, ['pt-br', 'pt'], ['en']), { primary: 'pt', secondary: 'en' });
  assert.deepEqual(langTags({ subs: [] }, ['pt-br', 'pt'], ['en']), { primary: '', secondary: '' });
});

test('a track list survives being remembered', () => {
  const back = expand(JSON.parse(JSON.stringify(compact(FILE))));
  assert.deepEqual(langTags(back, ['pt-br', 'pt'], ['es']), langTags(FILE, ['pt-br', 'pt'], ['es']));
  assert.equal(back.audio[0].lang, 'eng');
  assert.equal(back.subs[3].codec, 'hdmv_pgs_subtitle');
});

test('lookups go a few at a time, most wanted first; a source focused later jumps the line', async () => {
  const started = [];
  const finish = {};
  const done = [];
  const q = Queue({
    limit: 2,
    run: (item) => {
      started.push(item);
      return new Promise((res, rej) => (finish[item] = { res, rej }));
    },
    onDone: (key, item, res, err) => done.push(key + ':' + (err ? 'error' : res)),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  ['a', 'b', 'c', 'd'].forEach((k, i) => q.add(k, k, i));
  q.add('a', 'a', 0); // already started: nothing new
  await settle();
  assert.deepEqual(started, ['a', 'b']);
  q.add('d', 'd', -1); // focused: before c
  finish.a.res('A');
  await settle();
  assert.deepEqual(started, ['a', 'b', 'd']);
  finish.b.rej(new Error('no'));
  await settle();
  assert.deepEqual(started, ['a', 'b', 'd', 'c']);
  assert.deepEqual(done, ['a:A', 'b:error']);
  assert.equal(q.has('c'), true);
  assert.equal(q.busy(), true);
  q.stop();
  finish.c.res('C');
  finish.d.res('D');
  await settle();
  assert.deepEqual(done, ['a:A', 'b:error']); // nothing reported after stop()
  q.add('e', 'e', 0);
  await settle();
  assert.equal(started.length, 4);
});
