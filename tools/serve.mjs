// Servidor estático do dist/ para testar no navegador do PC (simula a TV em 1920x1080).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT || 5173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

// Addon de teste (só para desenvolvimento): http://localhost:5173/test-addon/manifest.json
const TEST_VIDEO = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4';
const TEST_LONG = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'; // ~10 min (HLS)
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
    return json({
      subtitles: [
        { id: 'teste-pt', lang: 'por', url: base + 'teste.srt' },
        { id: 'teste-ptbr', lang: 'pt-BR', url: base + 'teste-ptbr.srt' },
        { id: 'teste-ass', lang: 'eng', url: base + 'teste.ass' },
      ],
    });
  }
  if (p === '/test-addon/teste-ptbr.srt') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    return res.end(Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nLegenda brasileira: ação, coração\n\n2\n00:00:05,000 --> 00:00:09,000\nVocê não vai à praça?\n', 'latin1'));
  }
  if (p === '/test-addon/teste.ass') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(
      '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
        'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\an8\\pos(960,80)}ASS line, {\\i1}in italics{\\i0}\n' +
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

http
  .createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/test-addon/')) return testAddon(p, res);
    const file = path.join(dist, p === '/' ? 'index.html' : p);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`[serve] http://localhost:${port}`));
