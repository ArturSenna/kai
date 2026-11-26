// Styled ASS/SSA subtitles: libass compiled to WebAssembly (JASSUB) draws them on a canvas over
// the video with the script's own fonts, colours and positions. The files are fetched only when an
// .ass subtitle is picked, and only on an engine that can run them; anything that goes wrong calls
// onFail once, so the player falls back to the plain-text reading of the same file.
import { log } from './log.js';

const DIR = 'jassub/'; // dist/jassub, copied from the jassub package by tools/build.mjs
const READY_MS = 20000;

let scriptPromise = null;
let instance = null;
let host = null; // the video's parent, where JASSUB puts its canvas
let current = null; // token of the running start(); stop() or a newer start() drops it
let readyTimer = null;
let state = 'not used yet'; // shown in Settings → Playback diagnostics

// WebAssembly and workers; the script itself needs a 2020+ engine and simply fails to load on older ones.
export function supported() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function' && typeof EventTarget === 'function';
}

// The worker must come from the page's own address (browsers refuse a worker from elsewhere).
// The rest may come from where the app itself was loaded: the copy pinned to this build.
function url(file, samePage) {
  const base = samePage ? '' : window.__KAI_BASE__ || '';
  return new URL(base + DIR + file, document.baseURI).href;
}

function loadScript() {
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url('jassub.umd.js');
      s.onload = () => (window.JASSUB ? resolve(window.JASSUB) : reject(new Error('script did not run on this engine')));
      s.onerror = () => reject(new Error('script not found'));
      document.head.appendChild(s);
    }).catch((e) => {
      scriptPromise = null;
      throw e;
    });
  }
  return scriptPromise;
}

// Draws `text` (an ASS file) over videoEl until stop(). opts.offset: subtitle delay in seconds;
// opts.onFail(reason): called once if it can't draw (never after stop()).
export function start(videoEl, text, opts) {
  stop();
  const token = {};
  current = token;
  host = videoEl.parentNode;
  state = 'loading';
  const fail = (reason) => {
    if (current !== token) return;
    stop();
    state = 'failed: ' + reason;
    log.warn('Legenda ASS com estilo indisponível:', reason);
    opts.onFail(reason);
  };
  loadScript()
    .then((JASSUB) => {
      if (current !== token) return;
      instance = new JASSUB({
        video: videoEl,
        subContent: text,
        workerUrl: url('jassub-worker.js', true),
        wasmUrl: url('jassub-worker.wasm'),
        modernWasmUrl: url('jassub-worker-modern.wasm'),
        availableFonts: { 'liberation sans': url('default.woff2') },
        fallbackFont: 'liberation sans',
        // Timed from the video's own events: the TV's hardware player gives no per-frame callback to rely on.
        onDemandRender: false,
        timeOffset: -(opts.offset || 0),
      });
      instance.addEventListener('error', (e) => fail((e && ((e.error && e.error.message) || e.message)) || 'renderer error'));
      instance.addEventListener('ready', () => {
        if (current !== token) return;
        clearTimeout(readyTimer);
        state = 'ready';
        log.info('Legenda ASS com estilo: pronta');
      });
      readyTimer = setTimeout(() => fail('no answer from the renderer'), READY_MS);
    })
    .catch((e) => fail(e.message));
}

export function stop() {
  current = null;
  clearTimeout(readyTimer);
  if (instance) {
    try {
      instance.destroy();
    } catch (e) {
      /* already gone */
    }
    instance = null;
  }
  // A renderer that failed while starting leaves its (empty) canvas holder behind.
  if (host) {
    const left = host.querySelectorAll('.JASSUB');
    for (let i = 0; i < left.length; i++) left[i].parentNode.removeChild(left[i]);
    host = null;
  }
}

export function active() {
  return !!current;
}

// Same meaning as the text renderer's offset: positive shows the subtitles later.
export function setOffset(sec) {
  if (instance) instance.timeOffset = -sec;
}

export function status() {
  return state;
}
