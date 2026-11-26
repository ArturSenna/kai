// Language codes as add-ons and files really label them ("pob", "pt-BR", "Portuguese (Brazil)",
// "por", "eng"...) reduced to one canonical code, so a preference matches whatever the source calls it.
// Brazilian Portuguese is its own language here ('pt-br'), ahead of generic Portuguese ('pt').
// Pure functions: no DOM, so they also run under `npm test`.

// What Settings saves for "Português (Brasil)": Brazilian first, then any Portuguese.
export const PORTUGUESE_BR = ['pob', 'pt-br', 'por', 'pt'];

// canonical code -> the spellings seen in the wild (already normalised: lower case, no accents,
// words joined by "-"). Order matters for the loose match: 'pt-br' is tried before 'pt'.
const GROUPS = [
  ['pt-br', 'pob pb ptbr pt-br bra brazilian brazilian-portuguese brazillian-portuguese portuguese-br portuguese-brazil portuguese-brazilian portugues-br portugues-brasil portugues-do-brasil portugues-brasileiro'],
  ['pt', 'por pt pt-pt portuguese portugues portuguese-portugal portugues-portugal'],
  ['en', 'eng en english ingles'],
  ['es', 'spa es spl spn es-419 spanish espanol castellano latino'],
  ['ar', 'ara ar arabic arabe'],
  ['ja', 'jpn ja jp jap japanese japones'],
  ['fr', 'fre fra fr french frances'],
  ['de', 'ger deu de german alemao'],
  ['it', 'ita it italian italiano'],
  ['ko', 'kor ko korean coreano'],
  ['zh', 'chi zho zh zht zhe chinese chines mandarin cantonese'],
  ['ru', 'rus ru russian russo'],
  ['hi', 'hin hi hindi'],
];

const EXACT = {};
const LOOSE = []; // [alias, code]: words long enough to be searched inside a longer label
GROUPS.forEach((g) => {
  g[1].split(' ').forEach((alias) => {
    EXACT[alias] = g[0];
    if (alias.length >= 5) LOOSE.push([alias, g[0]]);
  });
});

const ACCENTS = { á: 'a', à: 'a', â: 'a', ã: 'a', ä: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', í: 'i', ì: 'i', î: 'i', ï: 'i', ó: 'o', ò: 'o', ô: 'o', õ: 'o', ö: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u', ç: 'c', ñ: 'n' };

// "Português (Brasil)" -> "portugues-brasil", "pt_BR" -> "pt-br"
function key(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/[^\u0000-\u007f]/g, (ch) => ACCENTS[ch] || ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The words of a track title, normalised: "Signs & Songs [Forçada]" -> ['signs', 'songs', 'forcada'].
export function words(text) {
  const k = key(text);
  return k ? k.split('-') : [];
}

// The language without its region: Brazilian Portuguese is Portuguese.
export function base(code) {
  return code === 'pt-br' ? 'pt' : code;
}

// A label that says "Brazil" somewhere ("Dublado BR", "PT-BR 5.1", "Brazilian").
function saysBrazil(k) {
  return /(^|-)(pt-br|ptbr|pob|br|bra|brasil|brazil|brazilian|brazillian|brasileiro)(-|$)/.test(k);
}

// Known language for an already normalised key, or '' when it names none.
function lookup(k) {
  if (!k) return '';
  if (EXACT[k]) return EXACT[k];
  const brazil = (code) => (code === 'pt' && saysBrazil(k) ? 'pt-br' : code);
  // "en-US", "eng-hi": the first part decides. "pt-xx" stays Portuguese unless it says Brazil.
  const first = k.split('-')[0];
  if (first.length <= 3 && EXACT[first]) return brazil(EXACT[first]);
  // A longer label ("Portuguese (Brazil) - SubDL"): a whole known word inside it.
  const padded = '-' + k + '-';
  for (let i = 0; i < LOOSE.length; i++) {
    if (padded.indexOf('-' + LOOSE[i][0] + '-') >= 0) return brazil(LOOSE[i][1]);
  }
  return '';
}

// Canonical code for a language code or name; unknown ones come back normalised ("fin" stays "fin").
export function canon(code) {
  const k = key(code);
  return lookup(k) || k;
}

// Language of an embedded track: files tag Brazilian dubs as plain "por" and say "Brasil" in the title.
export function ofTrack(code, label) {
  const c = canon(code);
  const l = key(label);
  if (c === 'pt' && saysBrazil(l)) return 'pt-br';
  if (!c || c === 'und') return lookup(l) || c; // untagged track: the title may name the language
  return c;
}

// A saved preference (['pob', 'pt-br', 'por', 'pt']) as ordered canonical codes (['pt-br', 'pt']).
export function prefs(list) {
  const out = [];
  (list || []).forEach((x) => {
    const c = canon(x);
    if (c && out.indexOf(c) < 0) out.push(c);
  });
  return out;
}
