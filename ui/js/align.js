// Lines up lyric lines with transcribed words (each with a time), tolerating missed words,
// ad-libs and wrong guesses. Order is kept, so a repeated chorus can't jump to another repeat.

export const normWord = w => String(w || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

export function tokenize(text) {
  return String(text || '').split(/\s+/).map(normWord).filter(Boolean);
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** 0..1 how alike two words are. */
export function wordSim(a, b) {
  if (a === b) return 1;
  const d = lev(a, b), L = Math.max(a.length, b.length);
  const r = 1 - d / L;
  return r >= 0.6 ? r : 0;
}

/**
 * lines: [{ text }], words: [{ text, start, end }] (ms).
 * Returns [{ t (ms or null), conf (0..1) }] per line. Lines with no matches are spread between neighbours.
 */
export function alignLines(lines, words) {
  const L = [], lineOf = [];
  lines.forEach((ln, i) => { for (const w of tokenize(ln.text)) { L.push(w); lineOf.push(i); } });
  const W = words.map(w => ({ ...w, n: normWord(w.text) })).filter(w => w.n);
  const n = L.length, m = W.length;
  const res = lines.map(() => ({ t: null, conf: 0 }));
  if (!n || !m) return res;

  // Needleman-Wunsch: match scores by similarity, small costs for skipping a lyric word or a heard word
  const GAP_L = -0.35, GAP_W = -0.25;
  const S = new Float32Array((n + 1) * (m + 1));
  const P = new Uint8Array((n + 1) * (m + 1)); // 1 diag, 2 up (skip lyric), 3 left (skip heard)
  const idx = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) { S[idx(i, 0)] = i * GAP_L; P[idx(i, 0)] = 2; }
  for (let j = 1; j <= m; j++) { S[idx(0, j)] = j * GAP_W * 0.2; P[idx(0, j)] = 3; } // leading noise is cheap
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = wordSim(L[i - 1], W[j - 1].n);
      const d = S[idx(i - 1, j - 1)] + (sim > 0 ? sim * 1.2 : -0.6);
      const u = S[idx(i - 1, j)] + GAP_L;
      const l = S[idx(i, j - 1)] + (i === n ? GAP_W * 0.2 : GAP_W); // trailing noise is cheap
      if (d >= u && d >= l) { S[idx(i, j)] = d; P[idx(i, j)] = 1; }
      else if (u >= l) { S[idx(i, j)] = u; P[idx(i, j)] = 2; }
      else { S[idx(i, j)] = l; P[idx(i, j)] = 3; }
    }
  }
  const match = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 || j > 0;) {
    const p = P[idx(i, j)];
    if (p === 1) { if (wordSim(L[i - 1], W[j - 1].n) > 0) match[i - 1] = j - 1; i--; j--; }
    else if (p === 2) i--;
    else j--;
  }

  // Per line: time of the first matched word, corrected for unmatched words before it
  const perLine = lines.map(() => ({ count: 0, matched: 0, first: null }));
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const li = lineOf[k], pl = perLine[li];
    if (pl.count === 0) pl.startK = k;
    pl.count++;
    if (match[k] >= 0) {
      pl.matched++;
      if (pl.first == null) {
        const w = W[match[k]];
        const before = k - pl.startK;
        const wordMs = Math.max(150, Math.min(600, (w.end - w.start) || 300));
        pl.first = Math.max(0, w.start - before * wordMs);
      }
    }
    pos++;
  }
  perLine.forEach((pl, i) => {
    if (pl.count && pl.first != null) res[i] = { t: Math.round(pl.first), conf: pl.matched / pl.count };
  });

  // Spread unmatched lines between matched neighbours by text length; keep times increasing
  const known = res.map((r, i) => (r.t != null ? i : -1)).filter(i => i >= 0);
  if (!known.length) return res;
  const weight = i => Math.max(1, tokenize(lines[i].text).length);
  for (let i = 0; i < lines.length; i++) {
    if (res[i].t != null || !tokenize(lines[i].text).length) continue;
    const a = [...known].reverse().find(k => k < i), b = known.find(k => k > i);
    if (a != null && b != null) {
      let tot = 0, acc = 0;
      for (let k = a; k < b; k++) tot += weight(k);
      for (let k = a; k < i; k++) acc += weight(k);
      res[i] = { t: Math.round(res[a].t + (res[b].t - res[a].t) * acc / tot), conf: 0 };
    } else if (a != null) {
      res[i] = { t: res[a].t + 2500 * (i - a), conf: 0 };
    } else if (b != null) {
      res[i] = { t: Math.max(0, res[b].t - 2500 * (b - i)), conf: 0 };
    }
  }
  let last = -Infinity;
  for (const r of res) {
    if (r.t == null) continue;
    if (r.t <= last) r.t = last + 50;
    last = r.t;
  }
  return res;
}

/** Turns transcribed words into timed lines, breaking at pauses and long runs. */
export function wordsToLines(words, { pauseMs = 650, maxWords = 10 } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const text = String(w.text || '').trim();
    if (!text) continue;
    const gap = cur ? w.start - cur.end : Infinity;
    const ends = cur && /[.!?]$/.test(cur.words[cur.words.length - 1]);
    if (!cur || gap > pauseMs || cur.words.length >= maxWords || (ends && cur.words.length >= 3)) {
      if (cur) lines.push(cur);
      cur = { t: w.start, end: w.end, words: [] };
    }
    cur.words.push(text);
    cur.end = w.end;
  }
  if (cur) lines.push(cur);
  return lines.map(l => ({
    t: Math.round(l.t),
    text: l.words.join(' ').replace(/\s+([,.!?])/g, '$1').replace(/^[a-z]/, c => c.toUpperCase()).replace(/[.,]$/, ''),
  }));
}
