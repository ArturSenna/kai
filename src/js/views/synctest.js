// The subtitle sync test from the source list (the → key on a source): the add-on subtitles in the
// preferred language are tested against this source's file before it plays (lib/presync.js), and
// the source starts with the one picked here, shifted when the test found it off by a fixed amount.
import { h, clear } from '../lib/dom.js';
import * as nav from '../lib/nav.js';
import { t } from '../lib/i18n.js';
import * as store from '../lib/store.js';
import * as server from '../api/server.js';
import * as addons from '../api/addons.js';
import * as subs from '../lib/subs.js';
import * as lang from '../lib/lang.js';
import { log } from '../lib/log.js';
import * as presync from '../lib/presync.js';
import * as pcread from '../lib/pcread.js';
import * as sourcesubs from '../lib/sourcesubs.js';
import * as filememory from '../lib/filememory.js';
import { langName, langShort, syncLabel } from '../lib/sublabels.js';

function subKey(s) {
  return s.id || s.url;
}

// o: { meta, video, stream, runtime: seconds (0 when unknown), tracks: the file's track list when
//   the source list has it, onTracks(tracks): the list was read here, onPlay(pick | null), onClose() }
// pick: { kind: 'addon', key, lang, addon } | { kind: 'embedded', index, lang }
export function openSyncTest(o) {
  const settings = store.settings();
  const groups = [lang.prefs(settings.subtitleLangs), lang.prefs(settings.subtitleLangs2)].filter((g) => g.length);
  const wanted = groups.reduce((a, g) => a.concat(g), []);
  const ident = sourcesubs.fileIdent(o.stream, o.video.id);
  const mediaUrl = o.stream.url;
  const at = presync.startAt(o.runtime);

  const statusText = h('div.st-status');
  const barFill = h('i');
  const bar = h('div.load-bar.st-bar', null, barFill);
  const list = h('div.modal-list', { 'data-scroll-y': '', 'data-pad-y': '80' });
  const name = String(o.stream.name || o.stream.addon || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' · ');
  const box = h('div.modal-box.center.synctest', null, [h('h3', { text: t('Sincronia das legendas') + (name ? ' · ' + name : '') }), statusText, bar, list]);
  const modal = h('div.modal', null, box);
  document.getElementById('app').appendChild(modal);
  const layer = nav.pushLayer(modal, { onBack: () => close() });

  let alive = true;
  let session = null;
  let timer = null;
  let rows = {}; // subtitle key -> its row's <small>
  let results = filememory.seenSync(ident);
  let tested = [];

  function close() {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    if (session) session.stop();
    nav.popLayer(layer);
    if (modal.parentNode) modal.parentNode.removeChild(modal);
    if (o.onClose) o.onClose();
  }

  function play(pick) {
    close();
    o.onPlay(pick);
  }

  function status(text, progress) {
    statusText.textContent = text;
    bar.style.visibility = progress === null ? 'hidden' : '';
    barFill.style.width = Math.round((progress || 0) * 100) + '%';
  }

  function option(label, sub, cls, onSelect) {
    const small = h('small', { text: sub });
    const el = h('div.opt', { focusable: true, cls: cls || '', onSelect: onSelect }, [label, small]);
    list.appendChild(el);
    return { el: el, small: small };
  }

  function showResult(key) {
    const row = rows[key];
    if (!row) return;
    const label = syncLabel(results[key]);
    const waiting = !session || !session.done();
    row.small.textContent = label.text || (waiting ? t('Testando a sincronia...') : t('Sincronia não confirmada'));
    row.el.classList.toggle('fits', label.cls === 'fits');
    row.el.classList.toggle('misfit', label.cls === 'misfit');
  }

  function build(tracks, all) {
    clear(list);
    rows = {};
    // The file's own track in a wanted language: in time by nature.
    const own = sourcesubs.dialogueTracks(tracks);
    const mine = own.filter((x) => wanted.indexOf(x.lang) >= 0).sort((a, b) => wanted.indexOf(a.lang) - wanted.indexOf(b.lang))[0];
    if (mine) {
      option(langName(mine.lang) + ' · ' + t('Embutida no arquivo'), t('Sempre em sincronia com o arquivo'), 'fits', () => play({ kind: 'embedded', index: mine.index, lang: mine.lang }));
    }
    tested = presync.candidates(all, groups);
    const count = {};
    tested.forEach((s) => {
      const key = subKey(s);
      const who = (s.addon || 'Addon') + ' · ' + langShort(lang.canon(s.lang));
      count[who] = (count[who] || 0) + 1;
      const label = langName(s.lang) + ' · ' + (s.addon || 'Addon') + ' #' + count[who];
      rows[key] = option(label, '', '', () => play({ kind: 'addon', key: key, lang: lang.canon(s.lang), addon: s.addon }));
      showResult(key);
    });
    option(t('Tocar sem escolher a legenda'), t('A legenda é escolhida sozinha, como sempre'), '', () => play(null));
    nav.focusFirst(modal);
  }

  function start(tracks, all) {
    if (!alive) return;
    build(tracks, all);
    if (!tested.length) {
      const names = wanted.map(langShort).join(' / ');
      status(names ? t('Nenhuma legenda de addon em {langs} para este vídeo.', { langs: names }) : t('Escolha o idioma da legenda em Ajustes.'), null);
      return;
    }
    if (tested.every((s) => results[subKey(s)])) {
      status(t('Já testadas com este arquivo.'), null);
      return;
    }
    log.info('Teste de sincronia antes de tocar: ' + tested.length + ' legenda(s), a partir de ' + at + 's');
    session = presync.Session({
      tracks: tracks,
      subs: tested,
      keyOf: subKey,
      cues: (s) => subs.loadFile(s.url, server.subtitlesProxy(s.url)).then((f) => f.cues),
      at: at,
      audioLangs: lang.prefs(settings.audioLangs),
      loader: (index) => pcread.subtitleTrack(mediaUrl, index, () => {}, () => {}),
      sampler: (audio, from, seconds, onDone, onFail) =>
        pcread.sound(
          mediaUrl,
          audio,
          from,
          seconds,
          (x) => alive && onDone(x),
          (why) => alive && onFail(why)
        ),
      known: results,
      onResult: (key, v) => {
        if (!alive) return;
        const s = tested.find((x) => subKey(x) === key);
        results[key] = v;
        filememory.rememberSync(ident, key, v, s ? lang.canon(s.lang) : '');
        log.info('Teste antes de tocar: ' + v.state + (v.state === 'shift' ? ' ' + v.shift + 's' : '') + ' (' + v.via + ')');
        showResult(key);
      },
    });
    timer = setInterval(tick, 250);
    tick();
  }

  function tick() {
    if (!alive || !session) return;
    session.tick();
    const s = session.status();
    if (s.step === 'track') status(t('Lendo a legenda embutida ({lang}) pelo PC...', { lang: langName(s.track.lang) }), s.progress);
    else if (s.step === 'sound') status(t('Ouvindo o áudio do arquivo pelo PC...'), s.progress);
    else if (s.step === 'compare') status(t('Comparando...'), 1);
    else {
      clearInterval(timer);
      status(s.step === 'off' ? t('O teste parou: {why}', { why: s.why || '?' }) : t('Pronto. Escolha uma legenda para tocar.'), null);
      tested.forEach((x) => showResult(subKey(x)));
      session.stop(); // the server stops reading the file
    }
  }

  status(t('Lendo as faixas do arquivo...'), 0);
  const tracks = o.tracks
    ? Promise.resolve(o.tracks)
    : server
        .tracks(mediaUrl)
        .then((tr) => {
          if (tr && o.onTracks) o.onTracks(tr);
          return tr;
        })
        .catch(() => null);
  Promise.all([tracks, addons.fetchSubtitles(o.meta.type, o.video.id, {}).catch(() => [])]).then((r) => {
    if (alive) start(r[0], r[1]);
  });
  return { close: close };
}
