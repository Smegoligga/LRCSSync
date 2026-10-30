// The timeline: ruler, waveform, frequency view with the voice band, voice activity and the lyric blocks.
import { hzToRow } from './voice.js';
import { nextTime } from './lrc.js';

const HOLD_MS = 420;
const HOLD_ZOOM = 6;
const MAX_PPS = 4000;
const TILE = 2048;

const C = {
  bg: '#0f1118', lane: '#141722', ruler: '#a4abc2', grid: 'rgba(255,255,255,0.06)',
  wave: '#7d8bb5', wavePlayed: '#b9c4ea',
  band: '#5ee6c1', dim: 'rgba(8,9,14,0.55)',
  voice: '#5ee6c1', region: 'rgba(94,230,193,0.13)', onset: 'rgba(94,230,193,0.7)',
  block: '#262b3d', blockBorder: '#3a405a', blockText: '#d9dcea', blockSel: '#8b7bff', blockSelText: '#ffffff',
  blockNow: '#3a3264', mark: 'rgba(139,123,255,0.35)', markSel: 'rgba(139,123,255,0.95)',
  playhead: '#ff5d73', muted: '#7c829a',
};

// dark navy -> violet -> teal -> pale
function colormap() {
  const stops = [[0, [15, 17, 24]], [0.35, [48, 36, 110]], [0.6, [123, 86, 220]], [0.8, [80, 200, 190]], [1, [235, 255, 245]]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    let k = 0;
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const [x0, c0] = stops[k], [x1, c1] = stops[k + 1];
    const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
    for (let c = 0; c < 3; c++) lut[v * 3 + c] = c0[c] + (c1[c] - c0[c]) * t;
  }
  return lut;
}

export class Timeline {
  constructor(canvas, host) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = host;
    this.view = { start: 0, pps: 50 };
    this.tiles = [];
    this.ptrs = new Map();
    this.g = null;
    this.hover = null;
    this.pending = false;
    this.lut = colormap();
    this.resize();
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(canvas);
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e, true));
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ---------- geometry ----------
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(50, r.width);
    this.H = Math.max(120, r.height);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    const ruler = 18, voice = 20, lyr = 42, gap = 2;
    const rest = this.H - ruler - voice - lyr - gap * 4;
    const wave = Math.round(rest * 0.34);
    const spec = rest - wave;
    let y = 0;
    const lane = h => { const l = { y, h }; y += h + gap; return l; };
    this.L = { ruler: lane(ruler), wave: lane(wave), spec: lane(spec), voice: lane(voice), lyr: lane(lyr) };
    this.clampView();
  }

  get duration() { return this.host.state.duration || 0; }
  span() { return this.W / this.view.pps; }
  x(t) { return (t - this.view.start) * this.view.pps; }
  t(x) { return this.view.start + x / this.view.pps; }
  minPps() { return this.duration ? Math.min(50, this.W / this.duration) : 1; }

  clampView() {
    const v = this.view;
    v.pps = Math.min(MAX_PPS, Math.max(this.minPps(), v.pps));
    const maxStart = Math.max(0, this.duration - this.span());
    v.start = Math.min(maxStart, Math.max(0, v.start));
  }

  fit() { this.view.pps = this.duration ? this.W / this.duration : 50; this.view.start = 0; this.clampView(); this.request(); }

  zoomAt(factor, x = this.W / 2) {
    const t = this.t(x);
    this.view.pps *= factor;
    this.clampView();
    this.view.start = t - x / this.view.pps;
    this.clampView();
    this.request();
  }

  /** Makes sure time `t` (s) is visible. */
  reveal(t, margin = 0.1) {
    const s = this.span();
    if (t < this.view.start || t > this.view.start + s) {
      this.view.start = t - s * margin;
      this.clampView();
      this.request();
    }
  }

  follow(t) {
    const s = this.span();
    if (this.g) return;
    if (t > this.view.start + s * 0.92 || t < this.view.start) {
      this.view.start = t - s * 0.08;
      this.clampView();
    }
  }

  yOfHz(hz) {
    const sp = this.host.state.spec, l = this.L.spec;
    if (!sp) return l.y;
    const row = hzToRow(sp, hz) + 0.5;
    return l.y + l.h * (1 - row / sp.bins);
  }

  hzOfY(y) {
    const sp = this.host.state.spec, l = this.L.spec;
    const row = (1 - (y - l.y) / l.h) * sp.bins;
    return sp.fMin * Math.exp((row / sp.bins) * Math.log(sp.fMax / sp.fMin));
  }

  // ---------- data ----------
  setSpectrogram(spec) {
    this.tiles = [];
    if (!spec) return;
    for (let f0 = 0; f0 < spec.frames; f0 += TILE) {
      const w = Math.min(TILE, spec.frames - f0);
      const c = document.createElement('canvas');
      c.width = w; c.height = spec.bins;
      const cx = c.getContext('2d');
      const img = cx.createImageData(w, spec.bins);
      const px = img.data, d = spec.data, B = spec.bins, lut = this.lut;
      for (let f = 0; f < w; f++) {
        const row = (f0 + f) * B;
        for (let b = 0; b < B; b++) {
          const v = d[row + b];
          const o = ((B - 1 - b) * w + f) * 4;
          px[o] = lut[v * 3]; px[o + 1] = lut[v * 3 + 1]; px[o + 2] = lut[v * 3 + 2]; px[o + 3] = 255;
        }
      }
      cx.putImageData(img, 0, 0);
      this.tiles.push({ f0, w, c });
    }
  }

  // ---------- drawing ----------
  request() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.draw(); });
  }

  draw() {
    const { ctx, W, H } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const S = this.host.state;
    if (!S.duration) return;
    for (const k of ['wave', 'spec', 'voice', 'lyr']) { ctx.fillStyle = C.lane; ctx.fillRect(0, this.L[k].y, W, this.L[k].h); }
    this.drawRuler();
    this.drawWave(S);
    this.drawSpec(S);
    this.drawVoice(S);
    this.drawMarks(S);
    this.drawLyrics(S);
    this.drawPlayhead(S);
    if (this.g && this.g.held) {
      const label = `ZOOM x${HOLD_ZOOM}`;
      ctx.font = '600 11px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(139,123,255,0.95)';
      roundRect(ctx, W - tw - 22, 2, tw + 14, 15, 4); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, W - tw - 15, 10);
    }
  }

  drawRuler() {
    const { ctx, W } = this, l = this.L.ruler;
    const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = steps.find(s => s * this.view.pps >= 64) || 300;
    ctx.fillStyle = C.ruler;
    ctx.strokeStyle = C.grid;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const t0 = Math.floor(this.view.start / step) * step;
    for (let t = t0; t <= this.view.start + this.span() + step; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      if (x < -50 || x > W + 50) continue;
      ctx.beginPath(); ctx.moveTo(x, l.y + l.h - 5); ctx.lineTo(x, this.H); ctx.stroke();
      const m = Math.floor(t / 60 + 1e-9), s = t - m * 60;
      const label = step < 1 ? `${m}:${s.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`;
      ctx.fillText(label, x + 3, l.y + l.h / 2);
    }
  }

  drawWave(S) {
    const { ctx, W } = this, l = this.L.wave;
    if (!S.peaks) return;
    const mid = l.y + l.h / 2, amp = (l.h / 2 - 2) / (S.peaks.norm || 1);
    const pps = this.view.pps, now = S.time;
    const usePcm = pps > 100 && S.pcm;
    const { min, max } = S.peaks;
    for (let x = 0; x < W; x++) {
      const t0 = this.t(x), t1 = t0 + 1 / pps;
      if (t1 < 0 || t0 > S.duration) continue;
      let lo = 0, hi = 0;
      if (usePcm) {
        const a = Math.max(0, Math.floor(t0 * 16000)), b = Math.min(S.pcm.length, Math.max(a + 1, Math.floor(t1 * 16000)));
        for (let i = a; i < b; i++) { const v = S.pcm[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      } else {
        const a = Math.max(0, Math.floor(t0 * 100)), b = Math.min(min.length, Math.max(a + 1, Math.floor(t1 * 100)));
        for (let i = a; i < b; i++) { if (min[i] < lo) lo = min[i]; if (max[i] > hi) hi = max[i]; }
      }
      ctx.fillStyle = t0 < now ? C.wavePlayed : C.wave;
      const y0 = mid - hi * amp, y1 = mid - lo * amp;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  drawSpec(S) {
    const { ctx, W } = this, l = this.L.spec, sp = S.spec;
    if (!sp) {
      ctx.fillStyle = C.muted; ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(S.analysing ? 'Analysing...' : '', 10, l.y + 18);
      return;
    }
    const hop = sp.hop;
    const f0 = this.view.start / hop, f1 = (this.view.start + this.span()) / hop;
    ctx.imageSmoothingEnabled = true;
    for (const tile of this.tiles) {
      const a = Math.max(f0, tile.f0), b = Math.min(f1, tile.f0 + tile.w);
      if (b <= a) continue;
      const dx = (a * hop - this.view.start) * this.view.pps;
      const dw = (b - a) * hop * this.view.pps;
      ctx.drawImage(tile.c, a - tile.f0, 0, b - a, sp.bins, dx, l.y, dw + 0.5, l.h);
    }
    // Voice band: dim outside, edges with handles
    const { lo, hi } = S.band;
    const yTop = Math.max(l.y, this.yOfHz(hi)), yBot = Math.min(l.y + l.h, this.yOfHz(lo));
    ctx.fillStyle = C.dim;
    ctx.fillRect(0, l.y, W, yTop - l.y);
    ctx.fillRect(0, yBot, W, l.y + l.h - yBot);
    const active = this.g && this.g.type.startsWith('band');
    const hov = this.hover && this.hover.type.startsWith('band');
    ctx.strokeStyle = C.band;
    ctx.lineWidth = active ? 2 : 1.25;
    ctx.beginPath(); ctx.moveTo(0, yTop + 0.5); ctx.lineTo(W, yTop + 0.5); ctx.moveTo(0, yBot - 0.5); ctx.lineTo(W, yBot - 0.5); ctx.stroke();
    ctx.lineWidth = 1;
    const hx = W - 46;
    ctx.fillStyle = C.band;
    for (const y of [yTop, yBot]) { roundRect(ctx, hx, y - 4, 36, 8, 4); ctx.fill(); }
    if (active || hov || true) {
      ctx.font = '600 10px system-ui, sans-serif';
      const txt = `VOICE ${fmtHz(lo)} - ${fmtHz(hi)}`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = 'rgba(15,17,24,0.75)';
      roundRect(ctx, W - tw - 60, yTop + 4, tw + 8, 15, 3); ctx.fill();
      ctx.fillStyle = C.band;
      ctx.fillText(txt, W - tw - 56, yTop + 12);
    }
    // Hz axis
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(200,205,225,0.65)';
    for (const hz of [100, 250, 500, 1000, 2000, 4000, 8000]) {
      if (hz > sp.fMax) continue;
      const y = this.yOfHz(hz);
      if (y < l.y + 6 || y > l.y + l.h - 3) continue;
      ctx.fillText(fmtHz(hz), 4, y);
    }
  }

  drawVoice(S) {
    const { ctx, W } = this, l = this.L.voice, v = S.voice;
    if (!v) return;
    ctx.fillStyle = C.region;
    for (const [a, b] of v.regions) {
      const x0 = this.x(a / 1000), x1 = this.x(b / 1000);
      if (x1 < 0 || x0 > W) continue;
      ctx.fillRect(x0, l.y, x1 - x0, l.h);
    }
    const hop = S.spec.hop, lev = v.level;
    ctx.fillStyle = C.voice;
    for (let x = 0; x < W; x++) {
      const a = Math.max(0, Math.floor(this.t(x) / hop)), b = Math.min(lev.length, Math.max(a + 1, Math.floor(this.t(x + 1) / hop)));
      let m = 0;
      for (let i = a; i < b; i++) if (lev[i] > m) m = lev[i];
      if (m > 0.02) ctx.fillRect(x, l.y + l.h - m * (l.h - 2), 1, m * (l.h - 2));
    }
    ctx.fillStyle = C.onset;
    for (const s of v.snaps) {
      const x = this.x(s / 1000);
      if (x < 0 || x > W) continue;
      ctx.fillRect(Math.round(x), l.y, 1, 4);
    }
  }

  drawMarks(S) {
    const { ctx } = this;
    const top = this.L.wave.y, bot = this.L.lyr.y;
    S.doc.lines.forEach((ln, i) => {
      if (ln.t == null) return;
      const x = Math.round(this.x(ln.t / 1000)) + 0.5;
      if (x < 0 || x > this.W) return;
      ctx.strokeStyle = i === S.sel ? C.markSel : C.mark;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke();
    });
  }

  blocks(S) {
    const lines = S.doc.lines, out = [];
    lines.forEach((ln, i) => {
      if (ln.t == null) return;
      const n = nextTime(lines, i);
      const end = n != null ? n : Math.min(S.duration * 1000, ln.t + 4000);
      out.push({ i, t: ln.t, end: Math.max(end, ln.t + 1) });
    });
    return out;
  }

  drawLyrics(S) {
    const { ctx, W } = this, l = this.L.lyr;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const b of this.blocks(S)) {
      const x0 = this.x(b.t / 1000), x1 = this.x(b.end / 1000);
      if (x1 < 0 || x0 > W) continue;
      const sel = b.i === S.sel, now = b.i === S.current;
      const w = Math.max(3, x1 - x0 - 1);
      ctx.fillStyle = sel ? C.blockSel : now ? C.blockNow : C.block;
      roundRect(ctx, x0, l.y + 3, w, l.h - 6, 4); ctx.fill();
      if (!sel) { ctx.strokeStyle = C.blockBorder; ctx.stroke(); }
      ctx.fillStyle = sel ? '#fff' : C.band;
      ctx.fillRect(Math.round(x0), l.y + 3, 2, l.h - 6);
      if (w > 14) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 + 5, l.y, w - 8, l.h); ctx.clip();
        const text = S.doc.lines[b.i].text;
        ctx.fillStyle = text ? (sel ? C.blockSelText : C.blockText) : C.muted;
        ctx.fillText(text || '(break)', Math.max(x0 + 6, 6), l.y + l.h / 2);
        ctx.restore();
      }
    }
  }

  drawPlayhead(S) {
    const { ctx } = this;
    const x = Math.round(this.x(S.time)) + 0.5;
    if (x < 0 || x > this.W) return;
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.H); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = C.playhead;
    ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill();
  }

  // ---------- interaction ----------
  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hit(x, y) {
    const S = this.host.state;
    if (!S.duration) return { type: 'none' };
    const L = this.L;
    if (S.spec && y >= L.spec.y && y < L.spec.y + L.spec.h) {
      const yTop = this.yOfHz(S.band.hi), yBot = this.yOfHz(S.band.lo);
      const tol = this.ptrType === 'touch' ? 14 : 7;
      if (Math.abs(y - yTop) <= tol) return { type: 'bandHi' };
      if (Math.abs(y - yBot) <= tol) return { type: 'bandLo' };
      if (y > yTop && y < yBot) return { type: 'bandMove' };
      return { type: 'empty' };
    }
    if (y >= L.lyr.y && y < L.lyr.y + L.lyr.h) {
      const tol = this.ptrType === 'touch' ? 16 : 6;
      let best = null, bestD = Infinity;
      for (const b of this.blocks(S)) {
        const x0 = this.x(b.t / 1000), x1 = this.x(b.end / 1000);
        const d = Math.abs(x - x0);
        if (d <= tol && d < bestD) { best = b; bestD = d; }
      }
      if (!best) for (const b of this.blocks(S)) {
        if (x >= this.x(b.t / 1000) && x < this.x(b.end / 1000)) best = b;
      }
      if (best) return { type: 'line', i: best.i };
    }
    return { type: 'empty' };
  }

  down(e) {
    this.ptrType = e.pointerType;
    const p = this.pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.ptrs.set(e.pointerId, p);
    if (this.ptrs.size === 2) {
      this.finishGesture(false);
      const [a, b] = [...this.ptrs.values()];
      this.g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, pps0: this.view.pps, tMid: this.t((a.x + b.x) / 2) };
      return;
    }
    if (this.ptrs.size > 2) return;
    const h = this.hit(p.x, p.y);
    if (h.type === 'none') return;
    const S = this.host.state;
    this.g = { ...h, x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false, held: false, view0: { ...this.view } };
    if (h.type === 'line') {
      this.g.ms0 = S.doc.lines[h.i].t;
      this.host.select(h.i, { fromTimeline: true });
    }
    if (h.type.startsWith('band')) this.g.band0 = { ...S.band };
    if (h.type !== 'bandLo' && h.type !== 'bandHi') this.holdTimer = setTimeout(() => this.enterHold(), HOLD_MS);
    this.request();
  }

  enterHold() {
    const g = this.g;
    if (!g || g.moved || g.held) return;
    if (g.type === 'bandMove') g.type = 'empty';
    g.held = true;
    g.prevView = { ...this.view };
    const t = this.t(g.x);
    this.view.pps = Math.min(MAX_PPS, this.view.pps * HOLD_ZOOM);
    this.view.start = t - g.x / this.view.pps;
    this.clampView();
    g.x0 = g.x;
    g.view0 = { ...this.view };
    if (g.type === 'line') g.ms0 = this.host.state.doc.lines[g.i].t;
    if (g.type === 'empty') this.host.seek(t);
    try { navigator.vibrate && navigator.vibrate(10); } catch { /* ignore */ }
    this.request();
  }

  move(e) {
    const p = this.pos(e);
    if (!this.ptrs.has(e.pointerId)) {
      // hover
      const h = this.hit(p.x, p.y);
      this.hover = h;
      this.canvas.style.cursor = h.type === 'line' ? 'ew-resize' : h.type === 'bandMove' ? 'grab' : h.type.startsWith('band') ? 'ns-resize' : 'default';
      return;
    }
    this.ptrs.set(e.pointerId, p);
    const g = this.g;
    if (!g) return;
    if (g.type === 'pinch') {
      if (this.ptrs.size < 2) return;
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = (a.x + b.x) / 2;
      this.view.pps = g.pps0 * d / g.d0;
      this.clampView();
      this.view.start = g.tMid - mid / this.view.pps;
      this.clampView();
      this.request();
      return;
    }
    g.x = p.x; g.y = p.y;
    if (!g.moved && Math.hypot(p.x - g.x0, p.y - g.y0) > (e.pointerType === 'touch' ? 8 : 4)) {
      g.moved = true;
      if (!g.held) clearTimeout(this.holdTimer);
    }
    if (!g.moved && !g.held) return;
    const S = this.host.state;
    if (g.type === 'line') {
      if (g.ms0 == null) return;
      const ms = g.ms0 + (p.x - g.x0) / this.view.pps * 1000;
      this.host.dragLine(g.i, ms, { alt: e.altKey || e.metaKey, radiusMs: 10 / this.view.pps * 1000 });
      this.edgeScroll(p.x);
    } else if (g.type.startsWith('band')) {
      const sp = S.spec;
      let { lo, hi } = g.band0;
      if (g.type === 'bandMove') {
        const dyRows = (p.y - g.y0) / this.L.spec.h;
        const k = Math.exp(-dyRows * Math.log(sp.fMax / sp.fMin));
        lo = g.band0.lo * k; hi = g.band0.hi * k;
        if (lo < sp.fMin) { hi *= sp.fMin / lo; lo = sp.fMin; }
        if (hi > sp.fMax) { lo *= sp.fMax / hi; hi = sp.fMax; }
      } else if (g.type === 'bandHi') {
        hi = Math.min(sp.fMax, Math.max(lo * 1.2, this.hzOfY(p.y)));
      } else {
        lo = Math.max(sp.fMin, Math.min(hi / 1.2, this.hzOfY(p.y)));
      }
      this.host.setBand(lo, hi, false);
    } else if (g.type === 'empty') {
      if (g.held) { this.host.seek(Math.max(0, Math.min(S.duration, this.t(p.x)))); this.edgeScroll(p.x); }
      else { this.view.start = g.view0.start - (p.x - g.x0) / this.view.pps; this.clampView(); }
    }
    this.request();
  }

  edgeScroll(x) {
    const edge = 24;
    if (x < edge) this.view.start -= (edge - x) / this.view.pps * 0.5;
    else if (x > this.W - edge) this.view.start += (x - (this.W - edge)) / this.view.pps * 0.5;
    this.clampView();
  }

  up(e, cancelled) {
    this.ptrs.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    const g = this.g;
    if (!g) return;
    if (g.type === 'pinch') { if (this.ptrs.size === 0) this.g = null; return; }
    this.finishGesture(!cancelled);
  }

  finishGesture(apply) {
    const g = this.g;
    if (!g) return;
    clearTimeout(this.holdTimer);
    this.g = null;
    const S = this.host.state;
    if (g.type === 'line') this.host.endDrag(g.i, apply && g.moved);
    else if (g.type.startsWith('band')) this.host.setBand(S.band.lo, S.band.hi, true);
    else if (g.type === 'empty' && apply && !g.moved && !g.held) this.host.seek(Math.max(0, Math.min(S.duration, this.t(g.x))));
    if (g.held && g.prevView) {
      // zoom back out around where the finger ended
      const t = this.t(g.x);
      this.view.pps = g.prevView.pps;
      this.view.start = t - g.x / this.view.pps;
      this.clampView();
    }
    this.request();
  }

  wheel(e) {
    if (!this.duration) return;
    e.preventDefault();
    const p = this.pos(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(Math.exp(-e.deltaY * 0.01), p.x);
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.view.start += d / this.view.pps;
      this.clampView();
      this.request();
    }
  }
}

function fmtHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
