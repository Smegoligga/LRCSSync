// Genius lyrics: search, fetch and clean. When Genius shows a bot check, the app opens a Genius window
// where you pass the check and the lyrics are sent back automatically.
import { httpFetch, isApp } from './platform.js';

const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/** Finds each element opened at `start` (index of '<div...') and returns its inner HTML. */
function innerOf(html, start) {
  const tagEnd = html.indexOf('>', start);
  let depth = 1, i = tagEnd + 1;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') depth--; else if (!m[0].endsWith('/>')) depth++;
    if (depth === 0) return { inner: html.slice(tagEnd + 1, m.index), end: re.lastIndex };
  }
  return { inner: html.slice(tagEnd + 1), end: html.length };
}

function removeExcluded(html) {
  let out = html, i;
  while ((i = out.search(/<div\b[^>]*data-exclude-from-selection="true"[^>]*>/i)) >= 0) {
    const { end } = innerOf(out, i);
    out = out.slice(0, i) + out.slice(end);
  }
  return out;
}

/** Lyrics text from a Genius song page (null if the page has none, e.g. a bot check). */
export function parseGeniusHtml(html) {
  const parts = [];
  const re = /<div\b[^>]*data-lyrics-container="true"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const { inner, end } = innerOf(html, m.index);
    const txt = decode(removeExcluded(inner).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
    parts.push(txt);
    re.lastIndex = end;
  }
  if (!parts.length) return null;
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function isBotCheck(status, html) {
  return status === 403 || status === 429 || status === 503 || /cf-chl|challenge-platform|Just a moment|cf-turnstile|captcha/i.test(html || '');
}

export class BotCheck extends Error {
  constructor(url) { super('Genius wants a quick check that you are human'); this.url = url; this.botCheck = true; }
}

export async function searchGenius(q) {
  const res = await httpFetch(`https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(q)}`, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok || isBotCheck(res.status, text)) throw new BotCheck(`https://genius.com/search?q=${encodeURIComponent(q)}`);
  const data = JSON.parse(text);
  const out = [];
  for (const sec of data?.response?.sections || []) {
    for (const h of sec.hits || []) {
      const r = h.result;
      if (h.type !== 'song' || !r || out.some(o => o.id === r.id)) continue;
      out.push({ id: r.id, title: r.title, artist: r.primary_artist?.name || r.artist_names || '', url: r.url, year: r.release_date_components?.year || (String(r.release_date_for_display || '').match(/\d{4}/) || [null])[0] });
    }
  }
  return out;
}

export async function fetchGeniusLyrics(url) {
  const res = await httpFetch(url, { method: 'GET', headers: { Accept: 'text/html' } });
  const html = await res.text();
  const lyrics = parseGeniusHtml(html);
  if (lyrics) return lyrics;
  if (isBotCheck(res.status, html) || !res.ok) throw new BotCheck(url);
  throw new Error('No lyrics on this Genius page');
}

/**
 * Opens a Genius window (desktop app) where you pass the check; resolves with the lyrics when they arrive.
 * Elsewhere opens the page in the browser and resolves null (copy the lyrics, then paste them).
 */
export async function openGeniusWindow(url) {
  const T = window.__TAURI__;
  if (T?.core?.invoke) {
    let unlisten;
    const got = new Promise(resolve => {
      T.event.listen('genius-lyrics', e => resolve(e.payload)).then(u => { unlisten = u; });
    });
    try {
      await T.core.invoke('open_genius', { url });
    } catch (e) {
      // phones can't open a second window: use the browser
      if (unlisten) unlisten();
      try { await T.opener.openUrl(url); } catch { window.open(url, '_blank'); }
      return null;
    }
    const text = await got;
    if (unlisten) unlisten();
    return text;
  }
  window.open(url, '_blank', 'noopener');
  return null;
}

export const geniusAvailable = () => isApp();
