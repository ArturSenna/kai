// Servidor estático do dist/ para testar no navegador do PC (simula a TV em 1920x1080).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT || 5173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

// Addon de teste (só para desenvolvimento): http://localhost:5173/test-addon/manifest.json
// TEST_VIDEO=<url> swaps the first test source, e.g. for an MKV with several audio and subtitle tracks.
const TEST_VIDEO = process.env.TEST_VIDEO || 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4';
const TEST_LONG = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'; // ~10 min (HLS)
// TEST_SUBS=<folder> lists every .srt in it as an add-on subtitle (language from the name:
// "anything.pob.srt" or "anything.pob.123.srt"), e.g. real ones to try the sync test against.
const TEST_SUBS = process.env.TEST_SUBS ? path.resolve(process.env.TEST_SUBS) : '';
const testSubs = () =>
  (TEST_SUBS ? fs.readdirSync(TEST_SUBS) : [])
    .filter((f) => f.endsWith('.srt'))
    .sort()
    .map((f) => ({ file: f, lang: (f.match(/\.([a-z]{2,3}(?:-[A-Za-z]{2})?)(?:\.[^.]+)?\.srt$/) || [])[1] || 'und' }));
function testAddon(p, res) {
  const json = (o) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(o));
  };
  if (p === '/test-addon/manifest.json') {
    return json({ id: 'kai.test', version: '1.0.0', name: 'Teste Kai', description: 'Fontes de teste', resources: ['stream', 'subtitles'], types: ['movie', 'series'], catalogs: [], idPrefixes: ['tt'] });
  }
  if (p.startsWith('/test-addon/stream/')) {
    return json({
      streams: [
        { name: 'Teste\nMP4 720p', title: 'Big Buck Bunny (10s)\nH.264 · AAC', url: TEST_VIDEO, behaviorHints: { bingeGroup: 'kai-test' } },
        { name: 'Teste\nHLS longo', title: 'Big Buck Bunny (10 min)\nHLS', url: TEST_LONG, behaviorHints: { bingeGroup: 'kai-test-long' } },
      ],
    });
  }
  if (p.startsWith('/test-addon/subtitles/')) {
    // Generic Portuguese first, so picking the Brazilian one proves the ranking; the Brazilian
    // file is Windows-1252 and labelled "pt-BR" (not OpenSubtitles' "pob"); plus an ASS file.
    const base = 'http://localhost:' + port + '/test-addon/';
    // The folder's subtitles first, in name order: the first one in a wanted language is the one
    // the app starts with.
    return json({
      subtitles: testSubs()
        .map((x) => ({ id: 'subs-' + x.file, lang: x.lang, url: base + 'subs/' + encodeURIComponent(x.file) }))
        .concat([
          { id: 'teste-pt', lang: 'por', url: base + 'teste.srt' },
          { id: 'teste-ptbr', lang: 'pt-BR', url: base + 'teste-ptbr.srt' },
          { id: 'teste-ass', lang: 'eng', url: base + 'teste.ass' },
        ]),
    });
  }
  if (p.startsWith('/test-addon/subs/')) {
    const hit = testSubs().find((x) => x.file === p.slice('/test-addon/subs/'.length));
    if (!hit) return json({});
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    return res.end(fs.readFileSync(path.join(TEST_SUBS, hit.file)));
  }
  if (p === '/test-addon/teste-ptbr.srt') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    return res.end(Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nLegenda brasileira: ação, coração\n\n2\n00:00:05,000 --> 00:00:09,000\nVocê não vai à praça?\n', 'latin1'));
  }
  if (p === '/test-addon/teste.ass') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    // Styled on purpose (yellow, top of the screen): with the styled renderer it looks nothing like plain text.
    return res.end(
      '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n' +
        '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
        'Style: Default,Arial,72,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,2,8,40,40,60,1\n\n' +
        '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
        'Dialogue: 0,0:00:00.50,0:00:04.00,Default,,0,0,0,,ASS line, {\\i1}in italics{\\i0}\n' +
        'Dialogue: 0,0:00:05.00,0:00:09.00,Default,,0,0,0,,Second line\\Nbroken in two\n'
    );
  }
  if (p === '/test-addon/teste.srt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end('1\n00:00:01,000 --> 00:00:04,000\nLegenda de teste <i>em itálico</i>\n\n2\n00:00:05,000 --> 00:00:09,000\nSegunda linha\nquebrada em duas\n');
  }
  res.writeHead(404);
  res.end();
}

// Stand-in for the PC's stremio-service (only for development): set the server address in the
// app's Settings to "localhost:<port>". It answers the three calls the player makes for a file's
// built-in tracks: is the server there, which tracks, and one subtitle track as WebVTT blocks.
function mockServer(p, res) {
  const send = (body, type) => {
    res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };
  if (p === '/settings') return send(JSON.stringify({ values: { serverVersion: 'mock' } }), 'application/json');
  if (p.startsWith('/tracks/')) {
    return send(
      JSON.stringify([
        { id: 0, type: 'video', codec: 'h264' },
        { id: 1, type: 'audio', lang: 'eng', label: 'English 5.1', codec: 'eac3', channels: 6 },
        { id: 2, type: 'audio', lang: 'por', label: 'Português (Brasil)', codec: 'aac', channels: 2 },
        { id: 3, type: 'text', lang: 'eng', label: 'Signs & Songs', codec: 'ass' },
        { id: 4, type: 'text', lang: 'por', label: 'Português (Brasil)', codec: 'ass' },
        { id: 5, type: 'text', lang: 'por', label: 'Forçada', codec: 'subrip' },
        { id: 6, type: 'text', lang: 'eng', label: 'English', codec: 'subrip' },
      ]),
      'application/json'
    );
  }
  const seg = p.match(/^\/hlsv2\/[^/]+\/subtitle(\d+)\/segment(\d+)\.vtt$/);
  if (seg) {
    const k = Number(seg[2]);
    const ts = (sec) => '00:' + String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0') + '.000';
    return send(`WEBVTT\n\n${ts((k - 1) * 10)} --> ${ts(k * 10)}\nFaixa embutida ${seg[1]}, bloco ${k}\n`, 'text/vtt; charset=utf-8');
  }
  return false;
}

http
  .createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/test-addon/')) return testAddon(p, res);
    if (mockServer(p, res) !== false) return;
    const file = path.join(dist, p === '/' ? 'index.html' : p);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`[serve] http://localhost:${port}`));
