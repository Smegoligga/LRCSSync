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

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

// ---- singing regions [[startMs, endMs]] (sorted, not overlapping) ----
/** Index of the region containing `ms`, or -1. */
function regionAt(regions, ms) {
  let lo = 0, hi = regions.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ms < regions[m][0]) hi = m - 1; else if (ms >= regions[m][1]) lo = m + 1; else return m;
  }
  return -1;
}
/** Index of the first region that starts after `ms` (regions.length if none). */
function regionAfter(regions, ms) {
  let lo = 0, hi = regions.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (regions[m][0] <= ms) lo = m + 1; else hi = m; }
  return lo;
}
/** cum[i] = total singing before region i. */
function cumulative(regions) {
  const cum = new Float64Array(regions.length + 1);
  for (let i = 0; i < regions.length; i++) cum[i + 1] = cum[i] + (regions[i][1] - regions[i][0]);
  return cum;
}
/** How much singing there is from 0 to `t`. */
function sungBefore(regions, cum, t) {
  let lo = 0, hi = regions.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (regions[m][1] <= t) lo = m + 1; else hi = m; }
  if (lo >= regions.length) return cum[regions.length];
  return cum[lo] + Math.max(0, t - regions[lo][0]);
}
/** The moment at which `a` ms of singing have passed (the start of the next region when it lands on a gap). */
function timeAtSung(regions, cum, a) {
  let lo = 0, hi = regions.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m + 1] <= a) lo = m + 1; else hi = m; }
  if (lo >= regions.length) return regions.length ? regions[regions.length - 1][1] : 0;
  return regions[lo][0] + (a - cum[lo]);
}

/**
 * Where a heard word really starts. Speech models stretch the first word after a silence backwards into
 * the silence (and sometimes make one word seconds long), so:
 *  - a start that falls in a gap moves to where the singing begins, if that is inside the word;
 *  - an absurdly long word is assumed to end on time and last about as long as the others.
 */
function wordStart(w, med, regions) {
  if (regions && regions.length && regionAt(regions, w.start) < 0) {
    const r = regions[regionAfter(regions, w.start)];
    if (r && r[0] <= Math.max(w.end - 60, w.start + 1)) return r[0];
  }
  const dur = w.end - w.start;
  if (dur > Math.max(2.5 * med, 900)) return w.end - Math.round(1.5 * med);
  return w.start;
}

/**
 * lines: [{ text }], words: [{ text, start, end }] (ms).
 * voice (optional): { regions: [[startMs, endMs]], starts: [ms], onsets: [ms] } - where singing was detected.
 * Returns [{ t (ms or null), conf (0..1) }] per line. Lines nobody heard are placed inside the singing between
 * their neighbours (never in an instrumental gap) and moved onto a nearby start of singing.
 */
export function alignLines(lines, words, { voice = null } = {}) {
  const L = [], lineOf = [];
  lines.forEach((ln, i) => { for (const w of tokenize(ln.text)) { L.push(w); lineOf.push(i); } });
  const W = words.map(w => ({ ...w, n: normWord(w.text) })).filter(w => w.n);
  const n = L.length, m = W.length;
  const res = lines.map(() => ({ t: null, conf: 0 }));
  if (!n || !m) return res;
  const regions = voice && voice.regions && voice.regions.length ? voice.regions : null;
  const med = Math.max(180, Math.min(450, median(W.map(w => w.end - w.start).filter(d => d > 0)) || 300));

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

  // Per line: where its first heard word really starts, stepped back for the words before it nobody heard
  const perLine = lines.map(() => ({ count: 0, matched: 0, first: null, strong: 0 }));
  let prevEnd = 0; // end of the last heard word of the lines before
  let lineLast = -1, curLine = -1;
  for (let k = 0; k < n; k++) {
    const li = lineOf[k], pl = perLine[li];
    if (li !== curLine) { if (lineLast >= 0) { const pw = W[lineLast]; prevEnd = Math.min(pw.end, pw.start + 2 * med); } curLine = li; lineLast = -1; }
    if (pl.count === 0) pl.startK = k;
    pl.count++;
    if (match[k] < 0) continue;
    const w = W[match[k]];
    pl.matched++;
    if (L[k].length >= 4 || L[k] === w.n && L[k].length >= 3) pl.strong++;
    lineLast = match[k];
    if (pl.first != null) continue;
    const before = k - pl.startK;
    const ws = wordStart(w, med, regions);
    const wordMs = Math.max(150, Math.min(600, Math.min((w.end - w.start) || med, 1.5 * med)));
    let t = ws - before * wordMs;
    if (regions && before) {
      // the line can't begin before the singing it is part of does
      const ri = regionAt(regions, ws);
      if (ri >= 0 && t < regions[ri][0] && regionAt(regions, t) < 0) t = regions[ri][0];
    }
    pl.first = Math.max(0, t, prevEnd);
  }
  perLine.forEach((pl, i) => {
    if (!pl.count || pl.first == null) return;
    // one short, common word out of a long line is as likely a coincidence as a match: place it like an unheard line
    if (pl.count >= 5 && pl.matched === 1 && !pl.strong) { res[i] = { t: null, conf: 0, weak: Math.round(pl.first) }; return; }
    res[i] = { t: Math.round(pl.first), conf: pl.matched / pl.count };
  });

  // Unheard lines: spread between heard neighbours by text length - through the singing, skipping the gaps
  const known = res.map((r, i) => (r.t != null ? i : -1)).filter(i => i >= 0);
  if (!known.length) {
    res.forEach(r => { if (r.weak != null) { r.t = r.weak; r.conf = 0.1; } delete r.weak; });
    return res;
  }
  const weight = i => Math.max(1, tokenize(lines[i].text).length);
  const cum = regions ? cumulative(regions) : null;
  // how long one word takes in this song (singing time), measured between the first and last heard line
  let perWord = med * 1.6;
  if (regions && known.length >= 3) {
    const k0 = known[0], k1 = known[known.length - 1];
    let wsum = 0;
    for (let k = k0; k < k1; k++) wsum += weight(k);
    const sung = sungBefore(regions, cum, res[k1].t) - sungBefore(regions, cum, res[k0].t);
    if (wsum >= 8 && sung > 0) perWord = Math.max(150, Math.min(900, sung / wsum));
  }
  const guessed = [];
  for (let i = 0; i < lines.length; i++) {
    if (res[i].t != null || !tokenize(lines[i].text).length) continue;
    const a = [...known].reverse().find(k => k < i), b = known.find(k => k > i);
    let t = null;
    if (a != null && b != null) {
      let tot = 0, acc = 0;
      for (let k = a; k < b; k++) tot += weight(k);
      for (let k = a; k < i; k++) acc += weight(k);
      const ta = res[a].t, tb = res[b].t;
      const sa = regions ? sungBefore(regions, cum, ta) : 0, sb = regions ? sungBefore(regions, cum, tb) : 0;
      // enough singing between the two to hold these lines? then walk through the singing, else through the clock
      if (regions && sb - sa > 250 * tot) t = timeAtSung(regions, cum, sa + (sb - sa) * acc / tot);
      else t = ta + (tb - ta) * acc / tot;
      t = Math.max(ta + 50, Math.min(tb - 50, t));
    } else if (a != null) {
      let acc = 0;
      for (let k = a; k < i; k++) acc += weight(k);
      const step = acc * perWord;
      t = regions ? Math.max(res[a].t + 50, timeAtSung(regions, cum, sungBefore(regions, cum, res[a].t) + step)) : res[a].t + 2500 * (i - a);
      if (regions && t >= regions[regions.length - 1][1]) t = res[a].t + 2500 * (i - a);
    } else if (b != null) {
      let acc = 0;
      for (let k = i; k < b; k++) acc += weight(k);
      const step = acc * perWord;
      t = regions ? timeAtSung(regions, cum, Math.max(0, sungBefore(regions, cum, res[b].t) - step)) : res[b].t - 2500 * (b - i);
      t = Math.max(0, Math.min(res[b].t - 50, t));
    }
    if (t != null) { res[i] = { t: Math.round(t), conf: 0 }; guessed.push(i); }
  }
  res.forEach(r => { delete r.weak; });

  // Move each guessed line onto a start of singing near its guess (kept in order, never past a heard neighbour)
  if (voice && guessed.length) {
    const starts = voice.starts && voice.starts.length ? voice.starts : (regions || []).map(r => r[0]);
    const onsets = voice.onsets || [];
    const est = res.map(r => r.t);
    const near = (arr, x, lo, hi) => {
      let i = 0, j = arr.length;
      while (i < j) { const mid = (i + j) >> 1; if (arr[mid] < x) i = mid + 1; else j = mid; }
      let best = null, bd = Infinity;
      for (const k of [i - 1, i, i + 1]) {
        const v = arr[k];
        if (v == null || v <= lo || v >= hi) continue;
        const d = Math.abs(v - x);
        if (d < bd) { bd = d; best = v; }
      }
      return best;
    };
    const prevT = i => { for (let k = i - 1; k >= 0; k--) if (res[k].t != null) return res[k].t; return -Infinity; };
    const nextE = i => { for (let k = i + 1; k < res.length; k++) if (est[k] != null) return est[k]; return Infinity; };
    for (const i of guessed) {
      const e = est[i], p = prevT(i), nx = nextE(i);
      const room = Math.min(isFinite(p) ? e - p : 3000, isFinite(nx) ? nx - e : 3000);
      const win = Math.max(150, Math.min(1500, 0.45 * room));
      const lo = Math.max(e - win, p + 300), hi = Math.min(e + win, nx - 200);
      let c = near(starts, e, lo, hi);
      if (c == null) { const w2 = Math.min(win, 400); c = near(onsets, e, Math.max(e - w2, p + 300), Math.min(e + w2, nx - 200)); }
      if (c != null) res[i].t = Math.round(c);
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

const SELF = /^(i|im|ill|id|ive|ima)$/; // "I", "I'm", "I'll"... are capitalised anywhere in a line

/** Index of the first value >= x in a sorted array. */
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Turns transcribed words into timed lines. A new line starts at:
 *  - a pause longer than `pauseMs`, or where the singing starts again after a breath (`starts`, ms, sorted),
 *  - a word the speech model capitalised (it capitalises the first word of each phrase - not "I", "I'm"...),
 *  - after . ! ? and after a comma once the line is long,
 *  - `maxWords` words.
 */
export function wordsToLines(words, { pauseMs = 650, maxWords = 10, starts = [] } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const text = String(w.text || '').trim();
    if (!text) continue;
    if (cur) {
      const n = cur.words.length, last = cur.words[n - 1];
      const gap = w.start - cur.end;
      const bare = text.replace(/[^\p{L}]/gu, '');
      const capital = /^\p{Lu}/u.test(bare) && !SELF.test(bare.toLowerCase()) && bare !== bare.toUpperCase();
      const k = lowerBound(starts, cur.lastStart + 200);
      const breath = k < starts.length && starts[k] <= w.start + 150;
      if (gap > pauseMs || n >= maxWords ||
          (/[.!?]["')]?$/.test(last) && n >= 2) ||
          (capital && n >= 2) ||
          (breath && n >= 3 && gap > 60) ||
          (/,$/.test(last) && n >= 6)) {
        lines.push(cur); cur = null;
      }
    }
    if (!cur) cur = { t: w.start, end: w.end, words: [] };
    cur.words.push(text);
    cur.end = w.end; cur.lastStart = w.start;
  }
  if (cur) lines.push(cur);
  return lines.map(l => ({
    t: Math.round(l.t),
    text: l.words.join(' ').replace(/\s+([,.!?])/g, '$1').replace(/^\p{Ll}/u, c => c.toUpperCase()).replace(/[.,]$/, ''),
  }));
}
