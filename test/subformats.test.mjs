import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, isAss, parseAss } from '../src/js/lib/subformats.js';

const SRT = '1\n00:00:01,000 --> 00:00:04,000\nVocê não vai à ação, coração.\n';

test('decode: UTF-8 stays UTF-8', () => {
  assert.equal(decode(new TextEncoder().encode(SRT).buffer), SRT);
});

test('decode: Windows-1252 file keeps its accents', () => {
  const bytes = Uint8Array.from(Buffer.from(SRT, 'latin1'));
  assert.equal(decode(bytes.buffer), SRT);
});

test('decode: Windows-1252 curly quotes and dash (not plain Latin-1)', () => {
  const bytes = Uint8Array.from([0x93, 0x4f, 0x69, 0x94, 0x20, 0x97]); // “Oi” —
  assert.equal(decode(bytes.buffer), '“Oi” —');
});

test('decode: UTF-16 LE with byte-order mark', () => {
  const bytes = Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ação', 'utf16le')]));
  assert.equal(decode(bytes.buffer), 'ação');
});

const ASS = `[Script Info]
Title: Teste
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Thought,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown
Dialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,Segunda, com vírgula\\Ne quebra
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\an8\\pos(640,60)}Olá, {\\i1}mundo{\\i0}!
Dialogue: 1,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\an8\\pos(640,60)}Olá, {\\i1}mundo{\\i0}!
Dialogue: 0,0:00:08.00,0:00:09.00,Thought,,0,0,0,,Pensando
Dialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}
Dialogue: 0,0:00:12.00,0:00:13.00,Default,,0,0,0,,{\\b1}<script>alert(1)</script> & {\\bord3}fim
Dialogue: 0,0:00:14.00,0:00:13.00,Default,,0,0,0,,ends before it starts
`;

test('isAss: tells ASS/SSA from SRT and VTT', () => {
  assert.equal(isAss(ASS), true);
  assert.equal(isAss(SRT), false);
  assert.equal(isAss('WEBVTT\n\n00:01.000 --> 00:04.000\nOi\n'), false);
  assert.equal(isAss('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,sem cabeçalho'), true);
});

test('parseAss: dialogue as plain cues, in time order', () => {
  const cues = parseAss(ASS);
  assert.deepEqual(
    cues.map((c) => [c.start, c.end, c.text]),
    [
      [1, 4, 'Olá, <i>mundo</i>!'], // override tags dropped, italics kept, layer duplicate merged
      [5, 7.5, 'Segunda, com vírgula\ne quebra'], // commas in the text, \N line break
      [8, 9, '<i>Pensando</i>'], // italic comes from the style
      [12, 13, '<b>&lt;script&gt;alert(1)&lt;/script&gt; &amp; fim</b>'], // escaped; \bord is not bold-off
    ]
  );
});

test('parseAss: old SSA layout (Marked instead of Layer) and CRLF', () => {
  const ssa = '[Events]\r\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nDialogue: Marked=0,0:00:01.00,0:00:02.00,*Default,NTP,0000,0000,0000,,Oi\r\n';
  assert.deepEqual(parseAss(ssa), [{ start: 1, end: 2, text: 'Oi' }]);
});

test('subs.parse: routes ASS to the ASS reader and still reads SRT', async () => {
  globalThis.window = globalThis; // lib/log.js hooks window.onerror when loaded
  const subs = await import('../src/js/lib/subs.js');
  assert.equal(subs.parse(ASS).length, 4);
  assert.deepEqual(subs.parse(SRT), [{ start: 1, end: 4, text: 'Você não vai à ação, coração.' }]);
});
