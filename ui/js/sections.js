// Song sections: which lyric lines form verses / choruses, where a section repeats in the audio,
// and where the instrumental gaps are.

const SEC_COLORS = ['#f2c14e', '#5ec8ff', '#ff8fab', '#a3e635', '#c4b5fd', '#fb923c', '#67e8f9', '#f472b6'];
export const secColor = group => SEC_COLORS[group % SEC_COLORS.length];

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Splits the lyrics into sections.
 * Uses blank lines / [Chorus] style headers when the lyrics have them, otherwise finds repeated runs of lines.
 * Returns [{ start, end, label, group, n, of }] where start/end are line indexes (end exclusive),
 * group is shared by repeats of the same section, n is which repeat (1-based) and `of` how many there are.
 */
export function findSections(lines) {
  const T = lines.map(l => norm(l.text));
  const isBreak = i => T[i] === '';
  let spans = [];

  const explicit = lines.some((l, i) => i > 0 && (l.sec || l.label));
  if (explicit) {
    let s = null;
    for (let i = 0; i <= lines.length; i++) {
      const boundary = i === lines.length || isBreak(i) || (i > 0 && (lines[i].sec || lines[i].label));
      if (boundary && s != null && i > s) { spans.push({ start: s, end: i, label: lines[s].label || null }); s = null; }
      if (i < lines.length && !isBreak(i) && s == null) s = i;
    }
  } else {
    spans = repeatedRuns(T, isBreak);
  }

  // Group sections whose lines mostly match
  const groups = [];
  for (const sp of spans) {
    const bag = T.slice(sp.start, sp.end);
    let g = groups.find(gr => similarity(gr.bag, bag) >= 0.6 || (sp.label && gr.label && baseLabel(sp.label) === baseLabel(gr.label) && /chorus|hook|refrain/i.test(sp.label)));
    if (!g) { g = { id: groups.length, bag, label: sp.label, members: [] }; groups.push(g); }
    g.members.push(sp);
    sp.group = g.id;
  }
  // Labels: keep explicit ones; the repeated group with most lines is the chorus; the rest are verses
  const repeated = groups.filter(g => g.members.length > 1).sort((a, b) => (b.members.length * b.bag.length) - (a.members.length * a.bag.length));
  const names = new Map();
  repeated.forEach((g, k) => names.set(g.id, k === 0 ? 'Chorus' : `Repeat ${String.fromCharCode(65 + k - 1)}`));
  let verse = 0;
  for (const sp of spans) {
    const m = sp.label && String(sp.label).match(/^verse\s*(\d+)/i);
    if (m) verse = Math.max(verse, +m[1]);
  }
  for (const g of groups) {
    for (const sp of g.members) sp.of = g.members.length;
    g.members.forEach((sp, k) => { sp.n = k + 1; });
  }
  for (const sp of spans) {
    if (!sp.label) {
      if (names.has(sp.group)) sp.label = names.get(sp.group);
      else sp.label = `Verse ${++verse}`;
    } else sp.label = baseLabel(sp.label, true);
  }
  return spans;
}

function baseLabel(l, keepNumber) {
  const s = String(l).replace(/\s*:.*$/, '').trim();
  return keepNumber ? s : s.replace(/\s*\d+$/, '').toLowerCase();
}

/** Share of lines in common (multiset), 0..1. */
export function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const x of a) counts.set(x, (counts.get(x) || 0) + 1);
  let common = 0;
  for (const x of b) { const c = counts.get(x); if (c) { common++; counts.set(x, c - 1); } }
  return common / Math.max(a.length, b.length);
}

/** Without section markers: repeated runs of 2+ lines become sections, the rest fills in between. */
function repeatedRuns(T, isBreak) {
  const n = T.length;
  const owner = new Array(n).fill(-1);
  const found = [];
  for (;;) {
    let best = null;
    for (let i = 0; i < n; i++) {
      if (owner[i] >= 0 || isBreak(i)) continue;
      for (let j = i + 1; j < n; j++) {
        if (owner[j] >= 0 || T[j] !== T[i]) continue;
        let L = 0;
        while (i + L < j && j + L < n && owner[i + L] < 0 && owner[j + L] < 0 && !isBreak(i + L) && T[i + L] === T[j + L]) L++;
        if (L >= 2 && (!best || L > best.L)) best = { i, j, L };
      }
    }
    if (!best) break;
    const id = found.length;
    const run = T.slice(best.i, best.i + best.L).join('\n');
    const starts = [];
    for (let k = 0; k + best.L <= n; k++) {
      let ok = true;
      for (let m = 0; m < best.L; m++) if (owner[k + m] >= 0 || isBreak(k + m)) { ok = false; break; }
      if (ok && T.slice(k, k + best.L).join('\n') === run) { starts.push(k); for (let m = 0; m < best.L; m++) owner[k + m] = id; k += best.L - 1; }
    }
    found.push(starts.map(s => ({ start: s, end: s + best.L })));
  }
  const spans = found.flat();
  // Fill the rest, split at breaks
  let s = null;
  for (let i = 0; i <= n; i++) {
    const free = i < n && owner[i] < 0 && !isBreak(i);
    if (free && s == null) s = i;
    if (!free && s != null) { spans.push({ start: s, end: i }); s = null; }
  }
  return spans.sort((a, b) => a.start - b.start).map(sp => ({ ...sp, label: null }));
}

/** Gaps without singing of at least `minMs`: [{ start, end }] in ms (includes the intro and outro). */
export function instrumentalGaps(regions, durationMs, minMs) {
  const out = [];
  let prev = 0;
  for (const [a, b] of regions) {
    if (a - prev >= minMs) out.push({ start: prev, end: a });
    prev = Math.max(prev, b);
  }
  if (durationMs - prev >= minMs) out.push({ start: prev, end: durationMs });
  return out;
}

// ---------------- matching sections in the audio ----------------

/**
 * Per 100 ms: a chroma vector (12 pitch classes) and a coarse timbre vector (8 bands), both unit length.
 * Used to find where a timed section repeats.
 */
export function audioFeatures(spec) {
  const step = Math.max(1, Math.round(0.1 / spec.hop));
  const blocks = Math.floor(spec.frames / step);
  const B = spec.bins, d = spec.data;
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.pow(10, ((v / 255) * spec.dbRange - spec.dbRange) / 10);
  const r = Math.log(spec.fMax / spec.fMin);
  const pc = new Int8Array(B), band = new Int8Array(B);
  for (let b = 0; b < B; b++) {
    const hz = spec.fMin * Math.exp(((b + 0.5) / B) * r);
    pc[b] = hz >= 80 && hz <= 4000 ? ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12 : -1;
    band[b] = Math.min(7, Math.floor((b / B) * 8));
  }
  const chroma = new Float32Array(blocks * 12), timbre = new Float32Array(blocks * 8);
  for (let k = 0; k < blocks; k++) {
    for (let f = k * step; f < (k + 1) * step; f++) {
      for (let b = 0; b < B; b++) {
        const p = lut[d[f * B + b]];
        if (pc[b] >= 0) chroma[k * 12 + pc[b]] += p;
        timbre[k * 8 + band[b]] += p;
      }
    }
    for (let i = 0; i < 8; i++) timbre[k * 8 + i] = Math.log10(timbre[k * 8 + i] + 1e-9) + 9;
    unit(chroma, k * 12, 12);
    unit(timbre, k * 8, 8);
  }
  return { blockMs: step * spec.hop * 1000, blocks, chroma, timbre };
}

function unit(a, o, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[o + i] * a[o + i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < n; i++) a[o + i] /= s;
}

function dot(a, i, b, j, n) {
  let s = 0;
  for (let k = 0; k < n; k++) s += a[i + k] * b[j + k];
  return s;
}

/**
 * Finds where the audio from [srcStart, srcEnd) ms sounds most alike inside [lo, hi] (start times, ms),
 * not overlapping the source itself. Returns { start, score } or null.
 */
export function findRepeat(feat, srcStart, srcEnd, lo, hi) {
  const bm = feat.blockMs;
  const s0 = Math.round(srcStart / bm), len = Math.max(2, Math.round((srcEnd - srcStart) / bm));
  if (s0 + len > feat.blocks) return null;
  const a = Math.max(0, Math.round(lo / bm)), b = Math.min(feat.blocks - len, Math.round(hi / bm));
  const scores = [];
  let top = -Infinity;
  for (let o = a; o <= b; o++) {
    if (o + len > s0 && o < s0 + len) { scores.push(null); continue; }
    let sc = 0;
    for (let k = 0; k < len; k++) {
      sc += 0.6 * dot(feat.chroma, (s0 + k) * 12, feat.chroma, (o + k) * 12, 12)
          + 0.4 * dot(feat.timbre, (s0 + k) * 8, feat.timbre, (o + k) * 8, 8);
    }
    sc /= len;
    scores.push(sc);
    if (sc > top) top = sc;
  }
  if (!isFinite(top)) return null;
  // Repeats often sound the same: take the earliest peak that's nearly as good as the best one
  for (let i = 0; i < scores.length; i++) {
    const v = scores[i];
    if (v == null || v < top - 0.015) continue;
    let j = i;
    while (j + 1 < scores.length && scores[j + 1] != null && scores[j + 1] >= scores[j]) j++;
    return { start: (a + j) * bm, score: scores[j] };
  }
  return null;
}

/** Maps each line of `dst` to a line of `src` (by text, in order; falls back to position). */
export function mapLines(srcTexts, dstTexts) {
  const S = srcTexts.map(norm), D = dstTexts.map(norm);
  const out = [];
  let p = 0;
  for (let i = 0; i < D.length; i++) {
    let k = -1;
    for (let j = p; j < S.length; j++) if (S[j] === D[i]) { k = j; break; }
    if (k < 0) k = Math.min(S.length - 1, Math.round(i * (S.length - 1) / Math.max(1, D.length - 1)));
    else p = k + 1;
    out.push(k);
  }
  return out;
}
