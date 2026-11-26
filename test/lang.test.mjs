import test from 'node:test';
import assert from 'node:assert/strict';
import { canon, ofTrack, prefs, words, base, PORTUGUESE_BR } from '../src/js/lib/lang.js';

test('Brazilian Portuguese, however the source spells it', () => {
  for (const s of ['pob', 'POB', 'pt-BR', 'pt_BR', 'ptbr', 'pb', 'Portuguese (Brazil)', 'Português (Brasil)', 'Brazilian', 'Brazilian Portuguese', 'Brazillian Portuguese', 'Portuguese (BR)', 'Portuguese (Brazil) - SubDL']) {
    assert.equal(canon(s), 'pt-br', s);
  }
});

test('generic Portuguese stays apart from Brazilian', () => {
  for (const s of ['por', 'pt', 'pt-PT', 'Portuguese', 'Português', 'Portuguese (Portugal)']) {
    assert.equal(canon(s), 'pt', s);
  }
});

test('other languages and regional variants', () => {
  assert.equal(canon('eng'), 'en');
  assert.equal(canon('en-US'), 'en');
  assert.equal(canon('English (SDH)'), 'en');
  assert.equal(canon('spa'), 'es');
  assert.equal(canon('Spanish (Latin America)'), 'es');
  assert.equal(canon('jpn'), 'ja');
  assert.equal(canon('ara'), 'ar');
  assert.equal(canon('zh-TW'), 'zh');
});

test('no substring false positives', () => {
  // The words the naive includes("pt") / includes("por") matcher tripped on.
  for (const s of ['description', 'captions', 'script', 'support', 'import', 'sport', 'export']) {
    assert.notEqual(canon(s), 'pt', s);
    assert.notEqual(canon(s), 'pt-br', s);
  }
  assert.equal(canon('fin'), 'fin'); // unknown codes pass through normalised
  assert.equal(canon(''), '');
  assert.equal(canon(null), '');
  assert.equal(canon(undefined), '');
});

test('embedded tracks: Brazil named in the title of a "por" track', () => {
  assert.equal(ofTrack('por', 'Português (Brasil) 5.1'), 'pt-br');
  assert.equal(ofTrack('por', 'Dublado BR'), 'pt-br');
  assert.equal(ofTrack('por', 'PT-BR'), 'pt-br');
  assert.equal(ofTrack('por', 'European Portuguese'), 'pt');
  assert.equal(ofTrack('por', ''), 'pt');
  assert.equal(ofTrack('eng', 'Brazil documentary commentary'), 'en'); // only Portuguese is refined
  assert.equal(ofTrack('und', 'Japanese'), 'ja');
  assert.equal(ofTrack('', 'pt'), 'pt');
  assert.equal(ofTrack('und', 'Commentary'), 'und');
});

test('the saved preference: Brazilian first, then any Portuguese', () => {
  assert.deepEqual(prefs(PORTUGUESE_BR), ['pt-br', 'pt']);
  assert.deepEqual(prefs(['eng', 'en']), ['en']);
  assert.deepEqual(prefs([]), []);
  assert.deepEqual(prefs(undefined), []);
});

test('words and base', () => {
  assert.deepEqual(words('Signs & Songs [Forçada]'), ['signs', 'songs', 'forcada']);
  assert.deepEqual(words(''), []);
  assert.deepEqual(words(undefined), []);
  assert.equal(base('pt-br'), 'pt');
  assert.equal(base('en'), 'en');
  assert.equal(base(''), '');
});
