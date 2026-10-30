// Voice band analysis: how loud the chosen frequency range is over time, where singing is,
// and where it starts (snap points).

export const DEFAULT_BAND = { lo: 150, hi: 4000 };

export function hzToRow(spec, hz) {
  const r = Math.log(spec.fMax / spec.fMin);
  return (Math.log(Math.max(hz, 1) / spec.fMin) / r) * spec.bins - 0.5;
}

export function rowToHz(spec, row) {
  const r = Math.log(spec.fMax / spec.fMin);
  return spec.fMin * Math.exp(((row + 0.5) / spec.bins) * r);
}

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

function smooth(a, radius) {
  const out = new Float32Array(a.length);
  let sum = 0, n = 0;
  for (let i = 0; i < a.length + radius; i++) {
    if (i < a.length) { sum += a[i]; n++; }
    if (i - 2 * radius - 1 >= 0) { sum -= a[i - 2 * radius - 1]; n--; }
    const c = i - radius;
    if (c >= 0 && c < a.length) out[c] = sum / n;
  }
  return out;
}

/**
 * Analyses the band [lo, hi] Hz.
 * Returns { level (0..1 per frame), regions [[startMs, endMs]], onsets [ms], snaps [ms] }.
 */
export function analyzeBand(spec, lo, hi) {
  const F = spec.frames, B = spec.bins, d = spec.data;
  const hopMs = spec.hop * 1000;
  let b0 = Math.max(0, Math.floor(hzToRow(spec, Math.min(lo, hi))));
  let b1 = Math.min(B - 1, Math.ceil(hzToRow(spec, Math.max(lo, hi))));
  if (b1 < b0) b1 = b0;
  const nb = b1 - b0 + 1;

  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.pow(10, ((v / 255) * spec.dbRange - spec.dbRange) / 10);

  const L = new Float32Array(F);
  const flux = new Float32Array(F);
  for (let f = 0; f < F; f++) {
    let e = 0, fl = 0;
    const row = f * B;
    const prev = f >= 2 ? (f - 2) * B : -1;
    for (let b = b0; b <= b1; b++) {
      e += lut[d[row + b]];
      if (prev >= 0) { const diff = d[row + b] - d[prev + b]; if (diff > 0) fl += diff; }
    }
    L[f] = 10 * Math.log10(e / nb + 1e-12);
    flux[f] = fl / nb;
  }
  const Ls = smooth(L, 2);
  const pLo = percentile(Ls, 0.1), pHi = percentile(Ls, 0.98);
  const span = Math.max(1e-6, pHi - pLo);
  const level = new Float32Array(F);
  for (let f = 0; f < F; f++) level[f] = Math.min(1, Math.max(0, (Ls[f] - pLo) / span));

  // Regions with hysteresis, minimum length and gap merging
  const minLen = Math.round(120 / hopMs), minGap = Math.round(200 / hopMs);
  let regions = [];
  let on = -1;
  for (let f = 0; f < F; f++) {
    if (on < 0 && level[f] > 0.5) on = f;
    else if (on >= 0 && level[f] < 0.35) { regions.push([on, f]); on = -1; }
  }
  if (on >= 0) regions.push([on, F]);
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < minGap) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  regions = merged.filter(r => r[1] - r[0] >= minLen);

  // Vocal starts: rises in the band (local peaks of spectral flux above a moving threshold)
  const fs = smooth(flux, 1);
  const base = smooth(fs, 50);
  const onsets = [];
  const win = 5, minDist = Math.round(120 / hopMs);
  for (let f = 1; f < F - 1; f++) {
    const v = fs[f];
    if (v < base[f] * 1.8 + 2 || level[f + 2 < F ? f + 2 : f] < 0.3) continue;
    let peak = true;
    for (let k = Math.max(0, f - win); k <= Math.min(F - 1, f + win); k++) if (fs[k] > v) { peak = false; break; }
    if (!peak) continue;
    if (onsets.length && f - onsets[onsets.length - 1] < minDist) continue;
    onsets.push(f);
  }

  const toMs = f => Math.round(f * hopMs);
  const regionsMs = regions.map(([a, b]) => [toMs(a), toMs(b)]);
  const onsetsMs = onsets.map(toMs);
  const snaps = Array.from(new Set([...regionsMs.map(r => r[0]), ...onsetsMs])).sort((a, b) => a - b);
  return { level, regions: regionsMs, starts: regionsMs.map(r => r[0]), onsets: onsetsMs, snaps };
}

/** Nearest snap point to `ms` within [ms - before, ms + after], or null. */
export function nearestSnap(snaps, ms, before, after = before) {
  if (!snaps || !snaps.length) return null;
  let lo = 0, hi = snaps.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (snaps[m] < ms) lo = m + 1; else hi = m; }
  let best = null, bestD = Infinity;
  for (const i of [lo - 1, lo, lo + 1]) {
    const s = snaps[i];
    if (s == null) continue;
    if (s < ms - before || s > ms + after) continue;
    const dd = Math.abs(s - ms);
    if (dd < bestD) { bestD = dd; best = s; }
  }
  return best;
}
