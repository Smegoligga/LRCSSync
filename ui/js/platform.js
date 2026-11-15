// File and network access: Tauri plugins in the app, browser APIs as a fallback.
import { wasmEmbed, wasmRead, tagsWasmAvailable } from './tagswasm.js';

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

/**
 * Browsers that can write back to a file the user opened (Chrome and Edge on a computer) get a file handle, so
 * "Write into this song" can overwrite it. Others (Firefox, Safari, phones) can only download a copy.
 */
export const canOverwriteInBrowser = () => !isApp() && typeof window.showOpenFilePicker === 'function';

async function pickBrowserHandle() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Audio', accept: { 'audio/*': AUDIO_EXT.map(e => '.' + e) } }],
    });
    const f = await handle.getFile();
    return { name: f.name, path: null, handle, bytes: new Uint8Array(await f.arrayBuffer()) };
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    return pickBrowser('audio/*');
  }
}

/** Asks for an audio file. Returns { name, path, bytes, handle? } or null. */
export async function pickAudio() {
  if (!isApp()) return canOverwriteInBrowser() ? pickBrowserHandle() : pickBrowser('audio/*');
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

/**
 * A web page can't read genius.com directly (the browser blocks it), so a site hosting the web build can run a
 * small relay and set window.LRCSSYNC_GENIUS_PROXY to its address (e.g. "/genius"). The relay only has to pass
 * GET /api/search/multi and song pages on to https://genius.com.
 */
export const geniusProxy = () => (typeof window !== 'undefined' && !T() && window.LRCSSYNC_GENIUS_PROXY) || null;

export function httpFetch(url, init) {
  const f = T()?.http?.fetch;
  if (f) return f(url, init);
  const relay = geniusProxy();
  if (relay && url.startsWith('https://genius.com/')) {
    return fetch(String(relay).replace(/\/+$/, '') + url.slice('https://genius.com'.length), { ...init, headers: { ...(init && init.headers), 'X-LRCSSync': '1' } });
  }
  return fetch(url, init);
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
    // Chrome/Edge: a handle for the dropped file, so it can be overwritten later (must be asked for right now)
    const item = [...(e.dataTransfer?.items || [])].find(i => i.kind === 'file');
    const handle = item && typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle().catch(() => null) : null;
    if (files.length) cb({ files, handle });
  });
}

export function load(key, def) {
  try { const v = localStorage.getItem('lrcssync.' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
}
export function store(key, value) {
  try { localStorage.setItem('lrcssync.' + key, JSON.stringify(value)); } catch { /* ignore */ }
}

/** Audio bytes with `lyrics` written into the tags (Rust core). */
export async function embedLyrics(audioBytes, lyrics) {
  const invoke = T()?.core?.invoke;
  if (!invoke) return wasmEmbed(audioBytes, lyrics);
  const text = new TextEncoder().encode(lyrics);
  const body = new Uint8Array(4 + text.length + audioBytes.length);
  new DataView(body.buffer).setUint32(0, text.length, true);
  body.set(text, 4);
  body.set(audioBytes, 4 + text.length);
  const res = await invoke('embed_lyrics', body);
  return new Uint8Array(res instanceof ArrayBuffer ? res : res.buffer ?? res);
}

/** Lyrics embedded in the audio's tags, or null. */
export async function readEmbedded(audioBytes) {
  const invoke = T()?.core?.invoke;
  if (!invoke) {
    if (!tagsWasmAvailable()) return null;
    try { return await wasmRead(audioBytes); } catch { return null; }
  }
  try { return await invoke('read_lyrics', audioBytes); } catch { return null; }
}

/** Whether this build can embed lyrics (apps always; the web version when its tag module is built in). */
export const canEmbed = () => isApp() || tagsWasmAvailable();

/** Overwrites a file with bytes: a path in the app, or a browser file handle. */
export async function writeBytes(path, bytes, handle) {
  if (handle) {
    if (handle.requestPermission && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      throw new Error('No permission to change the file');
    }
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    return;
  }
  await T().fs.writeFile(path, bytes);
}

/** Opens a link outside the app (browser, or another app such as Obtainium). */
export async function openExternal(url) {
  const o = T()?.opener;
  if (o?.openUrl) return o.openUrl(url);
  window.open(url, '_blank', 'noopener');
}

/** Asks where to save a copy of the song. */
export async function saveBytesAs(bytes, fileName, nearPath) {
  if (!isApp()) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes]));
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return fileName;
  }
  let defaultPath = fileName;
  if (nearPath && !/^[a-z]+:\/\//i.test(nearPath)) defaultPath = nearPath.replace(/[^\\/]+$/, fileName);
  const ext = (fileName.match(/\.([a-z0-9]+)$/i) || [])[1];
  const path = await T().dialog.save({ defaultPath, filters: ext ? [{ name: 'Audio', extensions: [ext] }] : undefined });
  if (!path) return null;
  await T().fs.writeFile(path, bytes);
  return path;
}
