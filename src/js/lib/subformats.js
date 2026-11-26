// Subtitle files beyond plain UTF-8 SRT/VTT: decoding the bytes (many .srt files are still
// Windows-1252, which breaks every "ç" and "ã") and reading ASS/SSA dialogue as plain text cues.
// Pure functions: no DOM, so they also run under `npm test`.

// Bytes -> text. UTF-8 when the bytes are valid UTF-8 (or UTF-16 with its mark), else Windows-1252.
export function decode(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof TextDecoder !== 'function') return decodeLegacy(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// Engines without TextDecoder: UTF-8 through the old escape() trick, else the bytes as Latin-1.
function decodeLegacy(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  try {
    return decodeURIComponent(escape(bin));
  } catch (e) {
    return bin;
  }
}

export function isAss(text) {
  const head = String(text).slice(0, 4000);
  return /^\s*\[(Script Info|V4\+? Styles|Events)\]/im.test(head) || /^Dialogue:\s*[^,]*,\s*\d+:\d\d:\d\d[.,]\d/m.test(head);
}

// "0:01:02.50" -> 62.5
function assTime(s) {
  const m = String(s).trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/);
  if (!m) return NaN;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + (m[4] ? parseFloat('0.' + m[4]) : 0);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One Dialogue text as safe HTML: {\i1}/{\b1}/{\u1} become <i>/<b>/<u>, every other override tag
// (position, colour, karaoke...) is dropped, and vector drawings ({\p1}...{\p0}) are skipped.
function assText(raw, italic) {
  const on = { i: !!italic, b: false, u: false };
  let out = italic ? '<i>' : '';
  let drawing = false;
  raw.split(/(\{[^}]*\})/).forEach((part) => {
    if (part.charAt(0) === '{' && part.charAt(part.length - 1) === '}') {
      const re = /\\([ibup])(\d+)/g;
      let m;
      while ((m = re.exec(part))) {
        const want = parseInt(m[2], 10) > 0;
        if (m[1] === 'p') drawing = want;
        else if (on[m[1]] !== want) {
          on[m[1]] = want;
          out += (want ? '<' : '</') + m[1] + '>';
        }
      }
    } else if (!drawing) {
      out += escapeHtml(part.replace(/\\N/g, '\n').replace(/\\[nh]/g, ' '));
    }
  });
  ['u', 'b', 'i'].forEach((tag) => {
    if (on[tag]) out += '</' + tag + '>';
  });
  // A line that ended up with markup only (a drawing, an empty sign) says nothing.
  return out.replace(/<[^>]*>/g, '').trim() ? out.trim() : '';
}

// Field names of a "Format:" line, lower case.
function formatFields(line) {
  return line
    .slice(line.indexOf(':') + 1)
    .split(',')
    .map((f) => f.trim().toLowerCase());
}

// ASS/SSA -> [{ start, end, text }] (seconds, safe HTML), the same shape the SRT/VTT parser returns.
// Styling beyond italics/bold/underline is not drawn: signs and karaoke show as plain lines.
export function parseAss(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let section = '';
  let styleFields = null;
  let eventFields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const italicStyles = {};
  const cues = [];
  const seen = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      section = sec[1].toLowerCase();
      continue;
    }
    if (/styles/.test(section)) {
      if (/^Format:/i.test(line)) styleFields = formatFields(line);
      else if (/^Style:/i.test(line) && styleFields) {
        const v = line.slice(line.indexOf(':') + 1).split(',');
        const name = (v[styleFields.indexOf('name')] || '').trim();
        const it = parseInt(v[styleFields.indexOf('italic')], 10);
        if (name && it) italicStyles[name] = true;
      }
      continue;
    }
    if (/^Format:/i.test(line)) {
      eventFields = formatFields(line);
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    // The text is the last field and may itself contain commas.
    const n = eventFields.length;
    const v = line.slice(line.indexOf(':') + 1).split(',');
    if (v.length < n) continue;
    const start = assTime(v[eventFields.indexOf('start')]);
    const end = assTime(v[eventFields.indexOf('end')]);
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    const style = (v[eventFields.indexOf('style')] || '').trim().replace(/^\*/, '');
    const body = assText(v.slice(n - 1).join(','), italicStyles[style]);
    if (!body) continue;
    // Typeset scripts repeat a line once per layer (glow, border): keep one.
    const key = start + '|' + end + '|' + body;
    if (seen[key]) continue;
    seen[key] = true;
    cues.push({ start: start, end: end, text: body, n: cues.length });
  }
  // By start time, file order on a tie (old engines' sort is not stable).
  cues.sort((a, b) => a.start - b.start || a.n - b.n);
  return cues.map((c) => ({ start: c.start, end: c.end, text: c.text }));
}
