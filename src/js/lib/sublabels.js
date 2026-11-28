// How languages and subtitle sync answers are written on screen (player menus, source list, the
// sync test panel).
import { t } from './i18n.js';
import * as lang from './lang.js';

const LANG_NAMES = {
  por: 'Português', pob: 'Português (BR)', pt: 'Português', 'pt-br': 'Português (BR)', eng: 'Inglês', en: 'Inglês',
  spa: 'Espanhol', es: 'Espanhol', jpn: 'Japonês', ja: 'Japonês', fre: 'Francês', fra: 'Francês', fr: 'Francês',
  ger: 'Alemão', deu: 'Alemão', de: 'Alemão', ita: 'Italiano', it: 'Italiano', kor: 'Coreano', ko: 'Coreano',
  chi: 'Chinês', zho: 'Chinês', rus: 'Russo', ara: 'Árabe', hin: 'Hindi', und: 'Indefinido',
  zh: 'Chinês', ru: 'Russo', ar: 'Árabe', hi: 'Hindi',
};

export function langName(code) {
  if (!code) return t('Desconhecido');
  // However the source spells it ("pt-BR", "Portuguese (Brazil)"): see lib/lang.js.
  const name = LANG_NAMES[String(code).toLowerCase()] || LANG_NAMES[lang.canon(code)];
  return name ? t(name) : code;
}

// A canonical code as a short tag: 'pt-br' -> 'PT-BR'.
export function langShort(code) {
  return String(code || '').toUpperCase();
}

export function signed(v) {
  return (v > 0 ? '+' : '') + v.toFixed(2).replace(/0$/, '');
}

// conf 0..1 as a percentage, never 0 or 100: the test can be wrong either way.
export function percent(conf) {
  return Math.max(1, Math.min(99, Math.round(conf * 100))) + '%';
}

// What a sync answer ({ state, shift, conf }) says, with a class for its colour ('fits' |
// 'misfit' | ''). The percentage is how sure the answer shown is: that it fits for "in sync",
// that it doesn't for "out of sync", the chance it fits when the test couldn't tell.
// Answers remembered before the percentage existed have no conf.
export function syncLabel(r) {
  if (!r) return { text: '', cls: '' };
  const has = typeof r.conf === 'number';
  const sure = (p) => (has ? percent(p) + ' · ' : '');
  if (r.state === 'ok') return { text: '✓ ' + sure(r.conf) + t('Acompanha este arquivo'), cls: 'fits' };
  if (r.state === 'shift') return { text: '✓ ' + sure(r.conf) + t('Acompanha este arquivo com ajuste de {n}s', { n: signed(r.shift) }), cls: 'fits' };
  if (r.state === 'bad') return { text: '✗ ' + sure(1 - r.conf) + t('Fora de sincronia com este arquivo'), cls: 'misfit' };
  if (r.state === 'unsure' && has) return { text: '? ' + percent(r.conf) + ' · ' + t('Sincronia não confirmada'), cls: '' };
  return { text: '', cls: '' };
}
