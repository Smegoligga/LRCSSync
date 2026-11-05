// Speech recognition with Whisper (transformers.js), on the device, in a background worker.
// Models download from Hugging Face the first time and are cached by the browser engine.

const LIB_VERSION = '3.8.1';
const CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${LIB_VERSION}/dist/`;

export const MODELS = {
  tiny: { id: 'Xenova/whisper-tiny', label: 'Tiny (about 40 MB, fastest)' },
  base: { id: 'Xenova/whisper-base', label: 'Base (about 80 MB)' },
  small: { id: 'Xenova/whisper-small', label: 'Small (about 250 MB, most accurate)' },
};

function config() {
  const o = window.LRCSSYNC_ASR || {};
  return { lib: o.lib || CDN + 'transformers.min.js', wasm: o.wasm || CDN, localPath: o.localPath || null };
}

const WORKER = `
let pipe = null, pipeId = null;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type !== 'chunk') return;
    if (!pipe || pipeId !== m.model) {
      const T = await import(m.cfg.lib);
      if (m.cfg.localPath) { T.env.allowLocalModels = true; T.env.allowRemoteModels = false; T.env.localModelPath = m.cfg.localPath; }
      else { T.env.allowLocalModels = false; }
      T.env.backends.onnx.wasm.wasmPaths = m.cfg.wasm;
      pipe = await T.pipeline('automatic-speech-recognition', m.model, {
        dtype: 'q8', device: 'wasm',
        progress_callback: p => self.postMessage({ type: 'download', p }),
      });
      pipeId = m.model;
    }
    const out = await pipe(m.audio, { return_timestamps: 'word', language: m.language || null, task: 'transcribe' });
    self.postMessage({ type: 'chunk', id: m.id, chunks: out.chunks || [], text: out.text || '' });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};`;

let worker = null;
function getWorker() {
  if (!worker) worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), { type: 'module' });
  return worker;
}

/** Removes rumble below ~120 Hz (bass and kick) so the voice stands out a little. */
export function voiceFilter(x, sr) {
  const out = new Float32Array(x.length);
  const f = 120, q = Math.SQRT1_2;
  const w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  const b0 = (1 + cs) / 2 / (1 + al), b1 = -(1 + cs) / (1 + al), b2 = b0, a1 = -2 * cs / (1 + al), a2 = (1 - al) / (1 + al);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass ? out : x;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      out[i] = y;
    }
  }
  return out;
}

/**
 * Transcribes 16 kHz mono audio. Returns words [{ text, start, end }] in ms.
 * onProgress({ phase: 'download'|'transcribe', done, total, file }); onChunk(wordsSoFar, fraction) after each piece.
 * `signal.aborted` stops between pieces.
 */
export async function transcribe(samples, { model = 'base', language = null, onProgress, onChunk, signal } = {}) {
  const SR = 16000, WIN = 28 * SR, STEP = 24 * SR, EDGE = 2 * SR;
  const audio = voiceFilter(samples, SR);
  const w = getWorker();
  const cfg = config();
  const modelId = (MODELS[model] || MODELS.base).id;
  const starts = [];
  for (let s = 0; s < audio.length; s += STEP) { starts.push(s); if (s + WIN >= audio.length) break; }
  const words = [];
  let id = 0;
  const onMsg = e => {
    if (e.data.type === 'download' && onProgress) {
      const p = e.data.p;
      if (p.status === 'progress') onProgress({ phase: 'download', file: p.file, done: p.loaded, total: p.total });
    }
  };
  w.addEventListener('message', onMsg);
  try {
    for (let k = 0; k < starts.length; k++) {
      if (signal && signal.aborted) break;
      const s = starts[k];
      const piece = audio.slice(s, Math.min(audio.length, s + WIN));
      onProgress && onProgress({ phase: 'transcribe', done: k, total: starts.length });
      const myId = ++id;
      const res = await new Promise((resolve, reject) => {
        const h = e => {
          if (e.data.id !== myId) return;
          w.removeEventListener('message', h);
          e.data.type === 'error' ? reject(new Error(e.data.message)) : resolve(e.data);
        };
        w.addEventListener('message', h);
        w.postMessage({ type: 'chunk', id: myId, audio: piece, model: modelId, language, cfg });
      });
      // keep words from the middle of each overlapping window
      const lo = k === 0 ? 0 : EDGE / SR, hi = k === starts.length - 1 ? Infinity : (WIN - EDGE) / SR;
      for (const c of res.chunks) {
        const [a, b] = c.timestamp || [];
        if (a == null || a < lo || a >= hi) continue;
        const text = String(c.text || '').trim();
        if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue; // [Music], (upbeat music)
        words.push({ text, start: Math.round((s / SR + a) * 1000), end: Math.round((s / SR + (b ?? a + 0.3)) * 1000) });
      }
      onChunk && onChunk(words.slice(), (k + 1) / starts.length);
    }
  } finally {
    w.removeEventListener('message', onMsg);
  }
  onProgress && onProgress({ phase: 'transcribe', done: starts.length, total: starts.length });
  return dedupeRepeats(words);
}

/** Whisper sometimes loops the same phrase over instrumentals: drop runs of 4+ identical words. */
export function dedupeRepeats(words) {
  const out = [];
  let run = 0;
  for (const w of words) {
    const prev = out[out.length - 1];
    run = prev && prev.text.toLowerCase() === w.text.toLowerCase() ? run + 1 : 0;
    if (run < 3) out.push(w);
  }
  return out;
}
