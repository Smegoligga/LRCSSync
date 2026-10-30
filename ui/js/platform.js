// File and network access: Tauri plugins in the app, browser APIs as a fallback.

const T = () => window.__TAURI__;
export const isApp = () => !!T();
export const isMobile = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

export const AUDIO_EXT = ['mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wav', 'wma', 'aif', 'aiff', 'webm', 'mp4'];

export function baseName(path) {
  let s = String(path || '');
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  return s.split(/[\\/:]/).pop() || s;
}

export function stripExt(name) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, '');
}

function pickBrowser(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
    };
    input.click();
  });
}

/** Asks for an audio file. Returns { name, path, bytes } or null. */
export async function pickAudio() {
  if (!isApp()) return pickBrowser('audio/*');
  const path = await T().dialog.open({
    multiple: false,
    filters: isMobile() ? undefined : [{ name: 'Audio', extensions: AUDIO_EXT }],
  });
  if (!path) return null;
  return readAudioPath(path);
}

export async function readAudioPath(path) {
  const bytes = await T().fs.readFile(path);
  return { name: baseName(path), path, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) };
}

/** Asks for a lyrics file. Returns { name, text } or null. */
export async function pickText() {
  if (!isApp()) {
    const f = await pickBrowser('.lrc,.txt,text/plain');
    return f && { name: f.name, text: new TextDecoder().decode(f.bytes) };
  }
  const path = await T().dialog.open({
    multiple: false,
    filters: isMobile() ? undefined : [{ name: 'Lyrics', extensions: ['lrc', 'txt'] }],
  });
  if (!path) return null;
  return { name: baseName(path), text: await T().fs.readTextFile(path) };
}

/** Looks for "song.lrc" next to "song.mp3" (desktop paths only). */
export async function readSidecar(audioPath) {
  if (!isApp() || !audioPath || /^[a-z]+:\/\//i.test(audioPath)) return null;
  const p = audioPath.replace(/\.[^.\\/]+$/, '.lrc');
  try {
    if (!(await T().fs.exists(p))) return null;
    return await T().fs.readTextFile(p);
  } catch { return null; }
}

/** Saves text. Returns the saved location, or null if cancelled. */
export async function saveText(text, fileName, nearPath) {
  if (!isApp()) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return fileName;
  }
  let defaultPath = fileName;
  if (nearPath && !/^[a-z]+:\/\//i.test(nearPath)) defaultPath = nearPath.replace(/[^\\/]+$/, fileName);
  const path = await T().dialog.save({ defaultPath, filters: [{ name: 'LRC lyrics', extensions: ['lrc'] }] });
  if (!path) return null;
  await T().fs.writeTextFile(path, text);
  return path;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function httpFetch(url, init) {
  const f = T()?.http?.fetch;
  return f ? f(url, init) : fetch(url, init);
}

/** Runs the Rust analysis; returns an ArrayBuffer, or null when not in the app. */
export async function analyzeNative(samples, sampleRate) {
  const invoke = T()?.core?.invoke;
  if (!invoke) return null;
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const res = await invoke('analyze', bytes, { headers: { 'sample-rate': String(sampleRate) } });
  return res instanceof ArrayBuffer ? res : (res?.buffer ?? new Uint8Array(res).buffer);
}

/** Calls back with dropped file paths (app) or File objects (browser). */
export function onFileDrop(cb) {
  const wv = T()?.webview?.getCurrentWebview?.();
  if (wv?.onDragDropEvent) {
    wv.onDragDropEvent(e => {
      if (e.payload.type === 'drop' && e.payload.paths?.length) cb({ paths: e.payload.paths });
    });
  }
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) cb({ files });
  });
}

export function load(key, def) {
  try { const v = localStorage.getItem('lrcssync.' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
}
export function store(key, value) {
  try { localStorage.setItem('lrcssync.' + key, JSON.stringify(value)); } catch { /* ignore */ }
}
