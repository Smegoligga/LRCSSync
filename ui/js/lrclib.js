// LRCLIB search (https://lrclib.net).
import { httpFetch, isApp } from './platform.js';

const API = 'https://lrclib.net/api';
const UA = 'LRCSSync (https://github.com/Smegoligga/LRCSSync)';

async function getJson(url) {
  const headers = isApp() ? { 'User-Agent': UA } : {};
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await httpFetch(url, { method: 'GET', headers });
    if (res.ok) return res.json();
    last = res.status;
    if (res.status < 500 && res.status !== 429) break;
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error(last >= 500 ? `LRCLIB is having problems right now (HTTP ${last}). Try again in a bit.` : `LRCLIB HTTP ${last}`);
}

/** Searches by title + artist, then by free text. Results sorted: synced first, closest length first. */
export async function search({ title, artist, album, q }, durationSec) {
  const urls = [];
  if (title) {
    const p = new URLSearchParams({ track_name: title });
    if (artist) p.set('artist_name', artist);
    if (album) p.set('album_name', album);
    urls.push(`${API}/search?${p}`);
    if (album) {
      const p2 = new URLSearchParams({ track_name: title });
      if (artist) p2.set('artist_name', artist);
      urls.push(`${API}/search?${p2}`);
    }
  }
  const free = q || [title, artist].filter(Boolean).join(' ');
  if (free) urls.push(`${API}/search?${new URLSearchParams({ q: free })}`);

  const seen = new Map();
  for (const u of urls) {
    const list = await getJson(u);
    for (const r of list || []) if (!seen.has(r.id)) seen.set(r.id, r);
    if (seen.size >= 5) break;
  }
  return rank([...seen.values()], durationSec);
}

export function rank(results, durationSec) {
  const diff = r => (durationSec && r.duration ? Math.abs(r.duration - durationSec) : 999);
  return results.slice().sort((a, b) => {
    const sa = a.syncedLyrics ? 0 : a.plainLyrics ? 1 : 2;
    const sb = b.syncedLyrics ? 0 : b.plainLyrics ? 1 : 2;
    const ca = diff(a) <= 3 ? 0 : 1, cb = diff(b) <= 3 ? 0 : 1;
    return ca - cb || sa - sb || diff(a) - diff(b);
  });
}
