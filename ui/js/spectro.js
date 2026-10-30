// Spectrogram: binary format from the Rust core, plus a JavaScript fallback with the same output
// (used when the app runs in a plain browser for testing).

export function parseSpectrogram(buffer) {
  const buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const v = new DataView(buf);
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (magic !== 'LRS1') throw new Error('Bad analysis data');
  const frames = v.getUint32(4, true), bins = v.getUint32(8, true);
  return {
    frames, bins,
    fMin: v.getFloat32(12, true), fMax: v.getFloat32(16, true), hop: v.getFloat32(20, true),
    dbMax: v.getFloat32(24, true), dbRange: v.getFloat32(28, true),
    data: new Uint8Array(buf, 32, frames * bins),
  };
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Same algorithm as core/src/spectrogram.rs. */
export function analyzeJs(samples, sampleRate) {
  const BINS = 128, F_MIN = 50, DB_RANGE = 90;
  const sr = Math.max(sampleRate, 1000);
  const hop = Math.max(1, Math.floor(sampleRate / 100));
  let win = 256; while (win < Math.floor(sr * 0.064)) win <<= 1;
  const fMax = Math.min(8000, sr / 2);
  const frames = samples.length ? Math.ceil(samples.length / hop) : 0;
  const w = new Float32Array(win);
  let wn = 0;
  for (let i = 0; i < win; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win); wn += w[i] * w[i]; }
  const fftBins = win / 2 + 1, binHz = sr / win, ratio = Math.log(fMax / F_MIN);
  const edge = k => F_MIN * Math.exp(k / BINS * ratio);
  const rows = [];
  for (let k = 0; k < BINS; k++) {
    const lo = edge(k), hi = edge(k + 1);
    rows.push([Math.ceil(lo / binHz), Math.min(fftBins, Math.ceil(hi / binHz)), Math.sqrt(lo * hi) / binHz]);
  }
  const re = new Float32Array(win), im = new Float32Array(win), pw = new Float32Array(fftBins);
  const db = new Float32Array(frames * BINS);
  for (let f = 0; f < frames; f++) {
    const start = f * hop - win / 2;
    for (let i = 0; i < win; i++) { const idx = start + i; re[i] = idx >= 0 && idx < samples.length ? samples[idx] * w[i] : 0; im[i] = 0; }
    fftInPlace(re, im);
    for (let i = 0; i < fftBins; i++) pw[i] = (re[i] * re[i] + im[i] * im[i]) / wn;
    for (let k = 0; k < BINS; k++) {
      const [a, b, c] = rows[k];
      let p;
      if (b > a) { p = 0; for (let i = a; i < b; i++) p += pw[i]; p /= b - a; }
      else { const i = Math.min(Math.floor(c), fftBins - 2), t = Math.min(1, Math.max(0, c - i)); p = pw[i] * (1 - t) + pw[i + 1] * t; }
      db[f * BINS + k] = 10 * Math.log10(p + 1e-12);
    }
  }
  let dbMax = -Infinity;
  for (const v of db) if (v > dbMax) dbMax = v;
  if (!isFinite(dbMax)) dbMax = 0;
  const data = new Uint8Array(frames * BINS);
  for (let i = 0; i < db.length; i++) data[i] = Math.max(0, Math.min(255, Math.round((db[i] - (dbMax - DB_RANGE)) / DB_RANGE * 255)));
  return { frames, bins: BINS, fMin: F_MIN, fMax, hop: hop / sr, dbMax, dbRange: DB_RANGE, data };
}
