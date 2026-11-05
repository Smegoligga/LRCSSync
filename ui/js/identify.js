// Works out which song is playing from the words heard so far, and only says so when it's sure.
import { tokenize, wordSim, normWord } from './align.js';
import { search as searchLrclib } from './lrclib.js';
import { searchGenius, fetchGeniusLyrics } from './genius.js';

const STOP = new Set('the a an and or but to of in on at for with my your you me i im its it is be was are we they he she this that so oh yeah na la uh ooh ah hey'.split(' '));

/**
 * How much of what was heard appears, in order, in the lyrics: matched / heard, counting only meaningful words.
 * The lyrics can start and end anywhere (what was heard is usually just the first part).
 */
export function matchRatio(lyricText, heardWords) {
  const L = tokenize(lyricText);
  const H = heardWords.map(w => normWord(w.text)).filter(w => w && !STOP.has(w) && w.length > 2);
  if (H.length < 6 || !L.length) return { ratio: 0, matched: 0, heard: H.length };
  const n = H.length, m = L.length;
  // local-in-lyrics alignment: best in-order matching of heard words against a stretch of lyrics
  let prev = new Float32Array(m + 1), cur = new Float32Array(m + 1);
  const cnt = [new Int32Array(m + 1), new Int32Array(m + 1)];
  let p = 0;
  for (let i = 1; i <= n; i++) {
    const q = 1 - p;
    cur[0] = prev[0] - 0.4; cnt[q][0] = cnt[p][0];
    for (let j = 1; j <= m; j++) {
      const s = wordSim(H[i - 1], L[j - 1]);
      const d = prev[j - 1] + (s > 0 ? s : -0.6);
      const up = prev[j] - 0.4;        // heard word not in lyrics
      const left = cur[j - 1] - 0.05;  // lyric word not heard (cheap: whisper misses words)
      if (d >= up && d >= left) { cur[j] = d; cnt[q][j] = cnt[p][j - 1] + (s > 0 ? 1 : 0); }
      else if (up >= left) { cur[j] = up; cnt[q][j] = cnt[p][j]; }
      else { cur[j] = left; cnt[q][j] = cnt[q][j - 1]; }
    }
    [prev, cur] = [cur, prev];
    p = q;
  }
  let best = 0;
  for (let j = 0; j <= m; j++) if (cnt[p][j] > best) best = cnt[p][j];
  return { ratio: best / n, matched: best, heard: n };
}

/** Distinctive 6-word phrases from what was heard, longest words first. */
export function phrases(words, count = 2) {
  const t = words.map(w => String(w.text).replace(/[^\p{L}\p{N}' ]/gu, '')).filter(Boolean);
  const out = [];
  for (let i = 0; i + 6 <= t.length; i += 3) {
    const ph = t.slice(i, i + 6);
    out.push({ q: ph.join(' '), score: ph.filter(w => !STOP.has(w.toLowerCase())).join('').length });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, count).map(x => x.q);
}

const sure = (m, durDiff) => m.ratio >= 0.55 && m.matched >= 8 && (durDiff == null || durDiff < 25);

/**
 * Returns { source, title, artist, synced, plain, ratio } for a song it's sure about, or null.
 * tags: { title, artist } from the file. durationSec: length of the song.
 */
export async function identify(heardWords, tags, durationSec, { useGenius = true } = {}) {
  const queries = [];
  if (tags.title) queries.push({ title: tags.title, artist: tags.artist });
  for (const q of phrases(heardWords)) queries.push({ q });
  const tried = new Set();
  let best = null;
  const consider = (cand, text) => {
    if (!text) return;
    const m = matchRatio(text, heardWords);
    const durDiff = cand.duration && durationSec ? Math.abs(cand.duration - durationSec) : null;
    if (sure(m, durDiff) && (!best || m.ratio > best.ratio)) best = { ...cand, ratio: m.ratio };
  };
  for (const q of queries) {
    try {
      const res = await searchLrclib(q, durationSec);
      for (const r of res.slice(0, 6)) {
        if (tried.has('l' + r.id)) continue;
        tried.add('l' + r.id);
        consider({ source: 'LRCLIB', title: r.trackName, artist: r.artistName, album: r.albumName, duration: r.duration, synced: r.syncedLyrics || null, plain: r.plainLyrics || null },
          r.plainLyrics || (r.syncedLyrics || '').replace(/\[[^\]]*]/g, ''));
      }
    } catch { /* offline or LRCLIB down: try the next source */ }
    if (best && best.synced) return best;
  }
  if (useGenius && !best) {
    for (const q of queries) {
      try {
        const hits = await searchGenius(q.q || `${q.title} ${q.artist || ''}`);
        for (const h of hits.slice(0, 3)) {
          if (tried.has('g' + h.id)) continue;
          tried.add('g' + h.id);
          const text = await fetchGeniusLyrics(h.url);
          consider({ source: 'Genius', title: h.title, artist: h.artist, synced: null, plain: text, url: h.url }, text);
        }
      } catch { /* bot check or offline: skip Genius in the background */ }
      if (best) break;
    }
  }
  return best;
}
