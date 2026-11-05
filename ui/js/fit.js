// Fits already-timed lyrics to this recording: finds the shift (and small stretch) that best lines the
// lyric lines up with where singing is heard. Handles extended intros and slightly different versions.

/** Lyric activity at 100 frames/s: 1 while a line is being sung (from its start to the next line, capped). */
export function lyricMask(lines, frames, hopMs, scale = 1, offset = 0) {
  const mask = new Float32Array(frames);
  const timed = lines.filter(l => l.t != null).sort((a, b) => a.t - b.t);
  for (let i = 0; i < timed.length; i++) {
    if (!timed[i].text) continue;
    const a = timed[i].t * scale + offset;
    const nxt = timed[i + 1] ? timed[i + 1].t * scale + offset : a + 4000;
    const words = String(timed[i].text).split(/\s+/).length;
    const b = Math.min(nxt, a + Math.max(1200, words * 450));
    const f0 = Math.max(0, Math.floor(a / hopMs)), f1 = Math.min(frames, Math.ceil(b / hopMs));
    for (let f = f0; f < f1; f++) mask[f] = 1;
  }
  return mask;
}

function score(level, mask) {
  // correlation of vocal level with the mask, both mean-centred
  let ml = 0, mm = 0;
  const n = level.length;
  for (let i = 0; i < n; i++) { ml += level[i]; mm += mask[i]; }
  ml /= n; mm /= n;
  let s = 0, sl = 0, sm = 0;
  for (let i = 0; i < n; i++) { const a = level[i] - ml, b = mask[i] - mm; s += a * b; sl += a * a; sm += b * b; }
  return sl && sm ? s / Math.sqrt(sl * sm) : 0;
}

/**
 * level: vocal level per frame (0..1), hopMs per frame.
 * Returns { offset (ms), scale, score, base (score unchanged), better } — `better` when the fit clearly helps.
 */
export function fitTiming(lines, level, hopMs, { maxShiftMs = 90000, durationHintMs = 0 } = {}) {
  const frames = level.length;
  // downsample to 50 ms for the coarse search
  const k = Math.max(1, Math.round(50 / hopMs));
  const lv = new Float32Array(Math.ceil(frames / k));
  for (let i = 0; i < frames; i++) lv[Math.floor(i / k)] = Math.max(lv[Math.floor(i / k)], level[i]);
  const ch = hopMs * k;
  const base = score(lv, lyricMask(lines, lv.length, ch));
  const scales = Math.abs(durationHintMs) > 1500 ? [0.97, 0.98, 0.99, 1, 1.01, 1.02, 1.03] : [0.99, 1, 1.01];
  let best = { offset: 0, scale: 1, score: base };
  for (const sc of scales) {
    for (let off = -maxShiftMs; off <= maxShiftMs; off += 100) {
      const s = score(lv, lyricMask(lines, lv.length, ch, sc, off));
      if (s > best.score) best = { offset: off, scale: sc, score: s };
    }
  }
  // refine at full resolution
  let fine = { ...best, score: score(level, lyricMask(lines, frames, hopMs, best.scale, best.offset)) };
  for (let off = best.offset - 150; off <= best.offset + 150; off += 10) {
    const s = score(level, lyricMask(lines, frames, hopMs, best.scale, off));
    if (s > fine.score) fine = { offset: off, scale: best.scale, score: s };
  }
  const moved = Math.abs(fine.offset) >= 150 || fine.scale !== 1;
  return { ...fine, base, better: moved && fine.score > base + 0.05 && fine.score > base * 1.15 };
}

/** New times after a fit. */
export function applyFit(t, fit) { return t == null ? null : Math.max(0, Math.round(t * fit.scale + fit.offset)); }
