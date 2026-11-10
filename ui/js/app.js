import { parse, format, stamp, clock, lineAt, nextTime, neighbours, newLine } from './lrc.js';
import { analyzeBand, nearestSnap, DEFAULT_BAND } from './voice.js';
import { parseSpectrogram, analyzeJs } from './spectro.js';
import { readTags } from './tags.js';
import { search as searchLrclib } from './lrclib.js';
import { History } from './history.js';
import { Timeline } from './timeline.js';
import * as P from './platform.js';
import { Player } from './player.js';
import { alignLines, wordsToLines } from './align.js';
import { replaceAll, countMatches } from './replace.js';
import { fitTiming, applyFit } from './fit.js';
import { transcribe, MODELS } from './asr.js';
import { identify } from './identify.js';
import { searchGenius, fetchGeniusLyrics, openGeniusWindow, geniusAvailable } from './genius.js';
import { rating, uncensor } from './censor.js';
import { findSections, instrumentalGaps, audioFeatures, findRepeat, mapLines, secColor } from './sections.js';

const SR = 16000;
const $ = id => document.getElementById(id);
const audio = new Player($('audio'));

const state = {
  duration: 0, time: 0, playing: false,
  file: null, tags: {},
  pcm: null, peaks: null, spec: null, voice: null, analysing: false,
  band: P.load('band', DEFAULT_BAND),
  doc: { meta: {}, lines: [] },
  sel: -1, current: -1,
  snap: P.load('snap', true), ripple: P.load('ripple', false), loop: false, follow: P.load('follow', true),
  tapComp: P.load('tapComp', 0), snapPx: P.load('snapPx', 10), gapSec: P.load('gapSec', 4),
  sections: [], gaps: [], feat: null,
  model: P.load('model', 'base'), lang: P.load('lang', ''), asrCache: null,
  dirty: false, version: '',
};
window.lrcs = state; // handy for debugging

const history = new History();
const timeline = new Timeline($('timeline'), {
  state,
  seek: t => seek(t),
  select: (i, o) => select(i, o),
  dragLine: (i, ms, o) => dragLine(i, ms, o),
  endDrag: (i, changed) => endDrag(i, changed),
  setBand: (lo, hi, final) => setBand(lo, hi, final),
});

// ---------------- helpers ----------------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

let cancelRequested = null;
function busy(text, { progress = null, cancel = null } = {}) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
  $('busyBar').hidden = progress == null;
  if (progress != null) $('busyFill').style.width = Math.round(Math.max(0, Math.min(1, progress)) * 100) + '%';
  $('busyCancel').hidden = !cancel;
  cancelRequested = cancel;
}
$('busyCancel').onclick = () => { if (cancelRequested) cancelRequested(); };

function setDirty(v = true) {
  state.dirty = v;
  document.title = (v ? '* ' : '') + 'LRCSSync' + (state.file ? ' - ' + state.file.name : '');
}

// ---------------- audio ----------------
async function decodeMono(bytes) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, SR, SR);
  const copy = bytes.slice().buffer;
  const buf = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(copy, res, rej);
    if (p && p.then) p.then(res, rej);
  });
  const n = buf.length, ch = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return { samples: out, rate: buf.sampleRate };
}

function computePeaks(pcm, rate) {
  const hop = Math.round(rate / 100);
  const frames = Math.ceil(pcm.length / hop);
  const min = new Float32Array(frames), max = new Float32Array(frames);
  let norm = 0;
  for (let f = 0; f < frames; f++) {
    let lo = 0, hi = 0;
    const end = Math.min(pcm.length, (f + 1) * hop);
    for (let i = f * hop; i < end; i++) { const v = pcm[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[f] = lo; max[f] = hi;
    norm = Math.max(norm, -lo, hi);
  }
  return { min, max, norm: norm || 1 };
}

async function openAudio(file) {
  if (!file) return;
  busy('Opening ' + file.name + '...');
  try {
    audio.load(file.bytes);
    audio.playbackRate = +$('speed').value;

    busy('Reading audio...');
    const { samples, rate } = await decodeMono(file.bytes);
    const hadSong = !!state.file;
    state.file = { name: file.name, path: file.path, bytes: file.bytes };
    state.tags = readTags(file.bytes, file.name);
    state.pcm = rate === SR ? samples : null;
    state.peaks = computePeaks(samples, rate);
    state.duration = samples.length / rate;
    state.time = 0;
    state.spec = null; state.voice = null; state.feat = null; state.gaps = [];
    $('fileName').textContent = [state.tags.artist, state.tags.title].filter(Boolean).join(' - ') || file.name;
    $('empty').hidden = true;
    if (!P.load('hintSeen', false)) {
      $('hint').hidden = false;
      setTimeout(() => { $('hint').hidden = true; P.store('hintSeen', true); }, 12000);
    }
    setDirty(state.dirty);
    timeline.fit();

    busy('Analysing...');
    state.analysing = true;
    let spec = null;
    try {
      const raw = await P.analyzeNative(samples, rate);
      if (raw) { spec = parseSpectrogram(raw); state.analysisSource = 'native'; }
    } catch (e) { console.warn('native analysis failed, using fallback', e); }
    if (!spec) { spec = analyzeJs(samples, rate); state.analysisSource = 'js'; }
    state.spec = spec;
    state.analysing = false;
    timeline.setSpectrogram(spec);
    updateVoice();

    const side = await P.readSidecar(file.path);
    const embedded = side ? null : await P.readEmbedded(file.bytes);
    if (side) {
      replaceDoc(parse(side), { quiet: true });
      toast('Loaded the .lrc next to this song');
    } else if (embedded) {
      replaceDoc(parse(embedded), { quiet: true });
      toast('Loaded the lyrics embedded in this song');
    } else {
      if (hadSong && state.doc.lines.length) replaceDoc({ meta: {}, lines: [], synced: false }, { quiet: true });
      toast('Now get lyrics: Lyrics > Search, paste or open a file');
    }
    if (!state.doc.meta.length) state.doc.meta.length = clock(state.duration).replace(/\.\d+$/, '');
    renderList();
  } catch (e) {
    console.error(e);
    toast("Couldn't open this file. " + (e && e.message ? e.message : ''), 5000);
  } finally {
    busy(null);
    updateClock();
    timeline.request();
  }
}

function seek(t) {
  t = Math.max(0, Math.min(state.duration || 0, t));
  state.time = t;
  try { audio.currentTime = t; } catch { /* not loaded */ }
  updateCurrent();
  timeline.request();
  updateClock();
}

function togglePlay() {
  if (!state.duration) return;
  if (audio.paused) audio.play().catch(e => toast("Can't play: " + e.message));
  else audio.pause();
}

audio.addEventListener('play', () => { state.playing = true; document.body.classList.add('playing'); loop(); });
audio.addEventListener('pause', () => { state.playing = false; document.body.classList.remove('playing'); });
audio.addEventListener('ended', () => { state.playing = false; document.body.classList.remove('playing'); });
audio.addEventListener('engine', () => { if (+$('speed').value !== 1) toast('Slow playback changes pitch on this system', 3000); });

function loop() {
  if (!state.playing) return;
  state.time = audio.currentTime;
  if (state.loop && state.sel >= 0) {
    const ln = state.doc.lines[state.sel];
    if (ln && ln.t != null) {
      const end = nextTime(state.doc.lines, state.sel) ?? ln.t + 4000;
      if (state.time * 1000 >= end || state.time * 1000 < ln.t - 1000) seek(ln.t / 1000);
    }
  }
  if (state.follow) timeline.follow(state.time);
  updateCurrent();
  updateClock();
  timeline.draw();
  requestAnimationFrame(loop);
}

function updateClock() {
  $('clock').textContent = `${clock(state.time)} / ${clock(state.duration)}`;
}

// ---------------- voice band ----------------
let bandRaf = 0;
function updateVoice() {
  if (!state.spec) return;
  state.voice = analyzeBand(state.spec, state.band.lo, state.band.hi);
  updateGaps();
  timeline.request();
}

function updateGaps() {
  state.gaps = state.voice ? instrumentalGaps(state.voice.regions, state.duration * 1000, state.gapSec * 1000) : [];
}

function setBand(lo, hi, final) {
  state.band = { lo: Math.round(lo), hi: Math.round(hi) };
  if (!bandRaf) bandRaf = requestAnimationFrame(() => { bandRaf = 0; updateVoice(); });
  if (final) P.store('band', state.band);
}

/** Snaps to the start of singing if one is in range, otherwise to the nearest rise in the voice band. */
function snapTo(ms, before, after) {
  if (!state.snap || !state.voice) return ms;
  const start = nearestSnap(state.voice.starts, ms, before, after);
  if (start != null) return start;
  const s = nearestSnap(state.voice.snaps, ms, before, after);
  return s == null ? ms : s;
}

// ---------------- document ----------------
function replaceDoc(d, { quiet } = {}) {
  history.push(state.doc);
  const meta = { ...d.meta };
  if (!meta.ti && state.tags.title) meta.ti = state.tags.title;
  if (!meta.ar && state.tags.artist) meta.ar = state.tags.artist;
  if (!meta.al && state.tags.album) meta.al = state.tags.album;
  state.doc = { meta, lines: d.lines };
  state.sel = d.lines.length ? (d.synced ? 0 : 0) : -1;
  setDirty(true);
  renderList();
  updateCurrent();
  timeline.request();
  if (!quiet) toast(d.synced ? `Loaded ${d.lines.length} timed lines` : `Loaded ${d.lines.length} lines. Play the song and press Tap as each line starts.`, 4000);
}

function applyDoc(d) {
  if (!d) return;
  state.doc = d;
  if (state.sel >= d.lines.length) state.sel = d.lines.length - 1;
  setDirty(true);
  renderList();
  updateCurrent();
  timeline.request();
}

function undo() { const d = history.back(state.doc); if (d) { applyDoc(d); toast('Undone', 1000); } }
function redo() { const d = history.forward(state.doc); if (d) { applyDoc(d); toast('Redone', 1000); } }

function select(i, { fromTimeline, reveal = true } = {}) {
  if (!state.doc.lines.length) { state.sel = -1; renderSelection(); return; }
  state.sel = Math.max(0, Math.min(state.doc.lines.length - 1, i));
  renderSelection();
  const ln = state.doc.lines[state.sel];
  if (!fromTimeline && reveal && ln.t != null && !state.playing) timeline.reveal(ln.t / 1000, 0.3);
  timeline.request();
}

/** Time a line, keeping list order unless `free` */
function setLineTime(i, ms, { ripple = state.ripple, clampOrder = true, orig } = {}) {
  const lines = state.doc.lines;
  const ln = lines[i];
  ms = Math.max(0, Math.round(ms));
  const old = orig ? orig[i] : ln.t;
  if (ripple && old != null) {
    const nb = neighbours(lines, i);
    if (nb.prev != null) ms = Math.max(ms, nb.prev + 10);
    const delta = ms - old;
    for (let j = i + 1; j < lines.length; j++) {
      const base = orig ? orig[j] : lines[j].t;
      if (base != null) lines[j].t = Math.max(0, base + delta);
    }
  } else if (clampOrder) {
    const nb = neighbours(lines, i);
    if (nb.prev != null) ms = Math.max(ms, nb.prev + 10);
    if (nb.next != null) ms = Math.min(ms, nb.next - 10);
  }
  ln.t = Math.max(0, ms);
  delete ln.conf;
}

let dragOrig = null;
function dragLine(i, ms, { alt, radiusMs }) {
  if (!dragOrig) { history.push(state.doc); dragOrig = state.doc.lines.map(l => l.t); }
  let t = ms;
  if (!alt) {
    const r = radiusMs * (state.snapPx / 10);
    t = snapTo(ms, r, r);
  }
  setLineTime(i, t, { orig: dragOrig });
  updateRow(i);
  if (state.ripple) for (let j = i + 1; j < state.doc.lines.length; j++) updateRow(j);
  updateSelLabel();
}

function endDrag(i, changed) {
  const orig = dragOrig;
  dragOrig = null;
  if (!orig) return;
  const same = state.doc.lines.every((l, j) => l.t === orig[j]);
  if (same) { history.undo.pop(); return; }
  setDirty(true);
  renderList();
}

let lastNudge = { at: 0, sel: -1 };
function nudge(delta) {
  const ln = state.doc.lines[state.sel];
  if (!ln) return;
  if (ln.t == null) { toast('This line has no time yet. Tap or Set here first.'); return; }
  const now = Date.now();
  if (now - lastNudge.at > 900 || lastNudge.sel !== state.sel) history.push(state.doc);
  lastNudge = { at: now, sel: state.sel };
  setLineTime(state.sel, ln.t + delta);
  setDirty(true);
  renderList();
  timeline.reveal(ln.t / 1000, 0.3);
  timeline.request();
  if (!state.playing) seek(ln.t / 1000);
}

function tap({ advance = true } = {}) {
  if (!state.duration) return;
  if (!state.doc.lines.length) { toast('Load some lyrics first'); return; }
  if (state.sel < 0) state.sel = 0;
  let ms = audio.currentTime * 1000 - state.tapComp;
  ms = snapTo(ms, 250, 80);
  history.push(state.doc);
  const ln = state.doc.lines[state.sel];
  ln.t = Math.max(0, Math.round(ms));
  delete ln.conf;
  setDirty(true);
  if (advance && state.sel < state.doc.lines.length - 1) state.sel++;
  renderList();
  timeline.request();
  flash($('btnTap'));
}

function flash(el) {
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function clearTime() {
  const ln = state.doc.lines[state.sel];
  if (!ln || ln.t == null) return;
  history.push(state.doc);
  ln.t = null;
  setDirty(true);
  renderList();
  timeline.request();
}

function insertLine() {
  history.push(state.doc);
  const at = state.sel >= 0 ? state.sel + 1 : state.doc.lines.length;
  state.doc.lines.splice(at, 0, newLine(null, ''));
  state.sel = at;
  setDirty(true);
  renderList();
  editLine(at);
}

function deleteLine() {
  if (state.sel < 0) return;
  history.push(state.doc);
  state.doc.lines.splice(state.sel, 1);
  if (state.sel >= state.doc.lines.length) state.sel = state.doc.lines.length - 1;
  setDirty(true);
  renderList();
  timeline.request();
}

function playLine() {
  const ln = state.doc.lines[state.sel];
  if (!ln || ln.t == null || !state.duration) return;
  seek(Math.max(0, ln.t / 1000 - 0.5));
  audio.play().catch(() => {});
}

// ---------------- list ----------------
const list = $('list');

function rowHtml(ln, i) {
  const cls = ['row'];
  if (ln.t == null) cls.push('untimed');
  if (ln.conf != null && ln.conf < 0.5 && ln.text) cls.push('check');
  if (i === state.sel) cls.push('sel');
  if (i === state.current) cls.push('now');
  const text = ln.text ? escapeHtml(ln.text) : '<span class="muted">(break)</span>';
  return `<div class="${cls.join(' ')}" data-i="${i}"><button class="t" tabindex="-1">${stamp(ln.t)}</button><div class="txt">${text}</div></div>`;
}


function secLines(sp) { const out = []; for (let i = sp.start; i < sp.end; i++) out.push(i); return out; }
function timedCount(sp) { return secLines(sp).filter(i => state.doc.lines[i].t != null).length; }
function siblings(sp) { return state.sections.filter(x => x.group === sp.group && x !== sp); }

function secHtml(k) {
  const sp = state.sections[k];
  const timed = timedCount(sp), size = sp.end - sp.start;
  const sib = siblings(sp);
  const btns = [];
  if (sib.length && timed) btns.push(`<button data-sec-act="copy" data-k="${k}" title="Use this section's timing for the other ${sib.length === 1 ? 'repeat' : 'repeats'}, found in the audio">Copy timing to ${sib.length === 1 ? 'the other one' : 'the other ' + sib.length}</button>`);
  if (sib.length && timed < size && sib.some(x => timedCount(x))) btns.push(`<button data-sec-act="find" data-k="${k}" title="Find this repeat in the audio and time it like the other one">Find in audio</button>`);
  if (timed) btns.push(`<button data-sec-act="play" data-k="${k}">Play</button>`);
  return `<div class="sec-head" style="--sec:${secColor(sp.group)}"><span class="sec-name">${escapeHtml(sp.label)}</span>${sp.of > 1 ? `<span class="muted">${sp.n} of ${sp.of}</span>` : ''}<span class="sec-btns">${btns.join('')}</span></div>`;
}

/** Times the `dsts` sections like `src`: anchored on their own first line if it's timed, otherwise found in the audio. */
function copySectionTiming(src, dsts) {
  const L = state.doc.lines;
  const idx = secLines(src);
  const timed = idx.filter(i => L[i].t != null);
  if (!timed.length) { toast('Time at least one line of this section first'); return; }
  const tFirst = Math.min(...timed.map(i => L[i].t));
  const lastIdx = timed.reduce((a, i) => (L[i].t > L[a].t ? i : a), timed[0]);
  const after = nextTime(L, lastIdx);
  const srcEnd = Math.min(after ?? Infinity, L[lastIdx].t + 6000);
  const rel = idx.map(i => (L[i].t == null ? null : L[i].t - tFirst));
  if (!state.feat && state.spec) state.feat = audioFeatures(state.spec);
  history.push(state.doc);
  let placed = 0;
  const weak = [];
  for (const dst of dsts.slice().sort((a, b) => a.start - b.start)) {
    const di = secLines(dst);
    const map = mapLines(idx.map(i => L[i].text), di.map(i => L[i].text));
    let anchor = null;
    if (L[di[0]].t != null && rel[map[0]] != null && dsts.length > 1) anchor = L[di[0]].t - rel[map[0]];
    if (anchor == null) {
      if (!state.feat) continue;
      const len = srcEnd - tFirst;
      let prev = null, next = null;
      L.forEach((l, i) => {
        if (l.t == null) return;
        if (i < dst.start && (prev == null || l.t > prev)) prev = l.t;
        if (i >= dst.end && (next == null || l.t < next)) next = l.t;
      });
      const lo = (prev ?? -200) + 200;
      let hi = next != null ? next - len * 0.5 : state.duration * 1000 - len;
      if (hi < lo) hi = lo;
      const r = findRepeat(state.feat, tFirst, srcEnd, lo, hi);
      if (!r) continue;
      anchor = r.start;
      if (r.score < 0.75) weak.push(`${dst.label} ${dst.n}`);
    }
    di.forEach((li, j) => { const r = rel[map[j]]; if (r != null) L[li].t = Math.max(0, Math.round(anchor + r)); });
    placed++;
  }
  if (!placed) { history.undo.pop(); toast("Couldn't place it. Tap the first line of the other section and try again.", 4500); return; }
  setDirty(true);
  renderList();
  timeline.request();
  toast(weak.length ? `Timed ${placed}. Check ${weak.join(', ')}: the audio match was weak.` : `Timed ${placed} section${placed > 1 ? 's' : ''} from ${src.label} ${src.n}`, 4500);
}

function sectionAction(act, k) {
  const sp = state.sections[k];
  if (!sp) return;
  if (act === 'copy') copySectionTiming(sp, siblings(sp));
  else if (act === 'find') {
    const src = siblings(sp).sort((a, b) => timedCount(b) - timedCount(a))[0];
    copySectionTiming(src, [sp]);
  } else if (act === 'play') {
    const t = Math.min(...secLines(sp).map(i => state.doc.lines[i].t).filter(t => t != null));
    seek(Math.max(0, t / 1000 - 0.5));
    audio.play().catch(() => {});
  }
}

/** Puts an empty (clearing) line at the start of each instrumental gap, so the last lyric doesn't stay up. */
function addBreaks() {
  if (!state.gaps.length) { toast('No instrumental parts found. Fit the voice band to the singer first.', 4000); return; }
  const L = state.doc.lines;
  history.push(state.doc);
  let added = 0;
  for (const g of state.gaps) {
    if (g.start <= 0) continue;
    const at = Math.round(g.start + 300);
    const cur = lineAt(L, at);
    if (cur < 0 || L[cur].text === '') continue;
    if (L.some(l => l.t != null && l.t > g.start && l.t < g.end - 300)) continue;
    let pos = -1;
    L.forEach((l, i) => { if (l.t != null && l.t <= at) pos = i; });
    L.splice(pos + 1, 0, newLine(at, ''));
    added++;
  }
  if (!added) { history.undo.pop(); toast('Every instrumental part already has a break'); return; }
  setDirty(true);
  renderList();
  timeline.request();
  toast(`Added ${added} break${added > 1 ? 's' : ''}. The status clears during instrumental parts now.`, 4000);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderList() {
  const lines = state.doc.lines;
  if (!lines.length) {
    list.innerHTML = `<div class="list-empty">${state.duration ? 'No lyrics yet. Use <b>Lyrics</b> to search LRCLIB, paste text or open a file.' : ''}</div>`;
  } else {
    state.sections = findSections(lines);
    const starts = new Map(state.sections.map((sp, k) => [sp.start, k]));
    list.innerHTML = lines.map((ln, i) => (starts.has(i) ? secHtml(starts.get(i)) : '') + rowHtml(ln, i)).join('');
  }
  if (!lines.length) state.sections = [];
  const untimed = lines.filter(l => l.t == null).length;
  $('btnLyrics').classList.toggle('attention', !!state.duration && !lines.length);
  list.dataset.untimed = untimed;
  renderSelection();
}

function updateRow(i) {
  const el = list.querySelector(`.row[data-i="${i}"]`);
  if (!el) return;
  const ln = state.doc.lines[i];
  el.querySelector('.t').textContent = stamp(ln.t);
  el.classList.toggle('untimed', ln.t == null);
}

function renderSelection() {
  for (const el of list.querySelectorAll('.row.sel')) el.classList.remove('sel');
  const el = list.querySelector(`.row[data-i="${state.sel}"]`);
  if (el) {
    el.classList.add('sel');
    const r = el.getBoundingClientRect(), lr = list.getBoundingClientRect();
    if (r.top < lr.top + 4 || r.bottom > lr.bottom - 4) el.scrollIntoView({ block: 'center' });
  }
  updateSelLabel();
}

function updateSelLabel() {
  const ln = state.doc.lines[state.sel];
  $('selLabel').textContent = ln ? `Line ${state.sel + 1} of ${state.doc.lines.length}  ${stamp(ln.t)}` : 'No line selected';
  document.body.classList.toggle('has-sel', !!ln);
}

function updateCurrent() {
  const c = lineAt(state.doc.lines, state.time * 1000 + 1);
  if (c === state.current) return;
  const old = list.querySelector('.row.now');
  if (old) old.classList.remove('now');
  state.current = c;
  const el = list.querySelector(`.row[data-i="${c}"]`);
  if (el) {
    el.classList.add('now');
    if (state.playing && state.follow && !list.querySelector('.row input')) {
      const r = el.getBoundingClientRect(), lr = list.getBoundingClientRect();
      if (r.top < lr.top || r.bottom > lr.bottom) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

list.addEventListener('click', e => {
  const sb = e.target.closest('[data-sec-act]');
  if (sb) { sectionAction(sb.dataset.secAct, +sb.dataset.k); return; }
  const row = e.target.closest('.row');
  if (!row || e.target.closest('input')) return;
  const i = +row.dataset.i;
  const ln = state.doc.lines[i];
  if (e.target.closest('.t')) {
    select(i);
    if (ln.t != null) seek(ln.t / 1000);
    return;
  }
  if (i === state.sel && e.target.closest('.txt')) { editLine(i); return; }
  select(i);
});
list.addEventListener('dblclick', e => {
  const row = e.target.closest('.row');
  if (row && e.target.closest('.txt')) editLine(+row.dataset.i);
});

function editLine(i) {
  const row = list.querySelector(`.row[data-i="${i}"]`);
  if (!row) return;
  const txt = row.querySelector('.txt');
  if (txt.querySelector('input')) return;
  const input = document.createElement('input');
  input.value = state.doc.lines[i].text;
  input.className = 'edit';
  txt.innerHTML = '';
  txt.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    const v = input.value.replace(/\s+/g, ' ').trim();
    if (save && v !== state.doc.lines[i].text) {
      history.push(state.doc);
      state.doc.lines[i].text = v;
      setDirty(true);
    }
    renderList();
    timeline.request();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------------- saving ----------------
function lrcText() {
  const meta = { ...state.doc.meta };
  if (!meta.ti && state.tags.title) meta.ti = state.tags.title;
  if (!meta.ar && state.tags.artist) meta.ar = state.tags.artist;
  return format({ meta, lines: state.doc.lines }, { version: state.version });
}

async function save() {
  if (!state.doc.lines.length) { toast('Nothing to save yet'); return; }
  const name = (state.file ? P.stripExt(state.file.name) : (state.doc.meta.ti || 'lyrics')) + '.lrc';
  try {
    const where = await P.saveText(lrcText(), name, state.file && state.file.path);
    if (!where) return;
    setDirty(false);
    const untimed = state.doc.lines.filter(l => l.t == null).length;
    toast(untimed ? `Saved. ${untimed} line(s) without a time were put at the end.` : 'Saved ' + P.baseName(where), 3500);
  } catch (e) {
    toast("Couldn't save: " + (e.message || e), 5000);
  }
}

// ---------------- automatic syncing ----------------
/** Shifts/stretches timed lyrics to this recording when that clearly fits better (extended intros etc.). */
function autoFit({ hintSec = 0, quiet = false } = {}) {
  if (!state.voice || !state.doc.lines.some(l => l.t != null)) return false;
  const f = fitTiming(state.doc.lines, state.voice.level, state.spec.hop * 1000, { durationHintMs: Math.abs(hintSec) * 1000 });
  if (!f.better) { if (!quiet && hintSec) toast('The timing already fits this recording', 2500); return false; }
  history.push(state.doc);
  for (const l of state.doc.lines) l.t = applyFit(l.t, f);
  setDirty(true);
  renderList();
  timeline.request();
  const sh = (f.offset / 1000).toFixed(1);
  const st = f.scale !== 1 ? ` and stretched ${((f.scale - 1) * 100).toFixed(1)}%` : '';
  toast(`Moved the lyrics ${f.offset >= 0 ? '+' : ''}${sh} s${st} to fit this recording. Ctrl+Z to undo.`, 5000);
  return true;
}

/** Nudges line starts onto the nearest start of singing. */
function snapAll(radius = 220) {
  if (!state.voice) return 0;
  let moved = 0, last = -Infinity;
  for (const l of state.doc.lines) {
    if (l.t == null) continue;
    if (l.text) {
      const s = nearestSnap(state.voice.starts, l.t, radius, radius * 0.7) ?? nearestSnap(state.voice.snaps, l.t, radius * 0.6, radius * 0.4);
      if (s != null && s > last + 50 && s !== l.t) { l.t = s; moved++; }
    }
    if (l.t <= last) l.t = last + 50;
    last = l.t;
  }
  return moved;
}

/** Transcribes the song with progress and a cancel button. Cached per song and model. */
async function listen({ onChunk } = {}) {
  const key = `${state.file?.name}|${state.duration}|${state.model}|${state.lang}`;
  if (state.asrCache && state.asrCache.key === key) return state.asrCache.words;
  const ctl = { aborted: false };
  busy('Getting the speech model ready...', { progress: 0, cancel: () => { ctl.aborted = true; busy('Stopping...'); } });
  const started = Date.now();
  try {
    const words = await transcribe(state.pcm, {
      model: state.model, language: state.lang || null, signal: ctl,
      onProgress: p => {
        if (ctl.aborted) return;
        if (p.phase === 'download' && p.total) busy(`Downloading the speech model (first time only)... ${Math.round(p.done / 1e6)} / ${Math.round(p.total / 1e6)} MB`, { progress: p.done / p.total, cancel: cancelRequested });
        else if (p.phase === 'transcribe') {
          const el = (Date.now() - started) / 1000, left = p.done ? Math.round(el / p.done * (p.total - p.done)) : null;
          busy(`Listening to the song... ${Math.round(p.done / p.total * 100)}%${left != null && p.done < p.total ? `, about ${left} s left` : ''}`, { progress: p.done / p.total, cancel: cancelRequested });
        }
      },
      onChunk: (w, frac) => onChunk && onChunk(w, frac, ctl),
    });
    if (ctl.aborted && !ctl.keep) return null;
    if (!ctl.aborted) state.asrCache = { key, words };
    return words;
  } catch (e) {
    console.error(e);
    toast("Speech recognition didn't work: " + (e.message || e) + '. It needs an internet connection the first time.', 7000);
    return null;
  } finally {
    busy(null);
  }
}

/** One click: times every line. Fits already-timed lyrics, otherwise listens and lines the lyrics up with the words. */
async function syncAll() {
  if (!state.duration) { toast('Open a song first'); return; }
  const L = state.doc.lines;
  const sung = L.filter(l => l.text);
  if (!sung.length) { writeFromAudio(); return; }
  const timed = sung.filter(l => l.t != null).length;
  if (timed >= sung.length * 0.6) {
    const fitted = autoFit({ quiet: true });
    history.push(state.doc);
    const moved = snapAll();
    const breaks = addBreaksQuiet();
    if (!moved && !breaks) history.undo.pop();
    setDirty(true); renderList(); timeline.request();
    toast(`${fitted ? 'Fitted to this recording. ' : ''}Lined up ${moved} line${moved === 1 ? '' : 's'} with the singing${breaks ? `, added ${breaks} break${breaks > 1 ? 's' : ''}` : ''}.`, 5000);
    return;
  }
  const words = await listen();
  if (!words) return;
  if (words.length < 5) { toast("Couldn't hear enough words. Fit the voice band to the singer, or try a bigger speech model in Settings.", 6000); return; }
  const res = alignLines(L, words, { voice: state.voice });
  history.push(state.doc);
  L.forEach((l, i) => { if (res[i].t != null) { l.t = res[i].t; l.conf = res[i].conf; } });
  snapAll(260);
  addBreaksQuiet();
  setDirty(true); renderList(); timeline.request();
  const check = L.filter(l => l.text && l.conf != null && l.conf < 0.5).length;
  toast(`Synced ${L.filter(l => l.t != null).length} lines.${check ? ` ${check} need a check (times in orange with a ?).` : ''}`, 6000);
}

/** Writes lyrics from the audio. Looks the song up while listening and uses the real lyrics when sure. */
async function writeFromAudio() {
  if (!state.duration) { toast('Open a song first'); return; }
  dlg.open && dlg.close();
  let found = null, lookup = null;
  const words = await listen({
    onChunk: (w, frac, ctl) => {
      const heardSec = w.length ? w[w.length - 1].end / 1000 : 0;
      if (!lookup && (w.length >= 25 || heardSec > 60 || frac >= 1)) {
        lookup = identify(w, state.tags, state.duration).then(r => {
          found = r;
          if (r && r.synced) { ctl.keep = true; ctl.aborted = true; } // real synced lyrics: no need to keep listening
        }).catch(() => {});
      }
    },
  });
  if (lookup) await lookup;
  if (found) {
    const d = found.synced ? parse(found.synced) : parse(found.plain);
    d.meta = { ...d.meta, ti: found.title, ar: found.artist, al: found.album };
    replaceDoc(d, { quiet: true });
    if (found.synced) {
      autoFit({ quiet: true });
      toast(`Recognised "${found.title}" by ${found.artist} and used its synced lyrics from ${found.source}.`, 6000);
    } else if (words && words.length) {
      const res = alignLines(state.doc.lines, words, { voice: state.voice });
      state.doc.lines.forEach((l, i) => { if (res[i].t != null) { l.t = res[i].t; l.conf = res[i].conf; } });
      snapAll(260);
      renderList(); timeline.request();
      toast(`Recognised "${found.title}" by ${found.artist}, used its lyrics from ${found.source} and timed them from the audio.`, 6000);
    }
    return;
  }
  if (!words) return;
  if (!words.length) { toast("Couldn't hear any words. Try a bigger speech model in Settings.", 5000); return; }
  const lines = wordsToLines(words, { starts: state.voice ? state.voice.starts : [] }).map(l => { const ln = newLine(l.t, l.text); ln.conf = 0.4; return ln; });
  replaceDoc({ meta: { ti: state.tags.title, ar: state.tags.artist }, lines, synced: true }, { quiet: true });
  snapAll(320);   // the speech model's word times are rough: move each line onto where the singing actually starts
  addBreaksQuiet();
  renderList(); timeline.request();
  toast(`Wrote ${lines.length} lines from the audio. It's a draft: check the words before saving.`, 6000);
}

function addBreaksQuiet() {
  const before = state.doc.lines.length;
  const L = state.doc.lines;
  for (const g of state.gaps) {
    if (g.start <= 0) continue;
    const at = Math.round(g.start + 300);
    const cur = lineAt(L, at);
    if (cur < 0 || L[cur].text === '') continue;
    if (L.some(l => l.t != null && l.t > g.start && l.t < g.end - 300)) continue;
    let pos = -1;
    L.forEach((l, i) => { if (l.t != null && l.t <= at) pos = i; });
    L.splice(pos + 1, 0, newLine(at, ''));
  }
  return state.doc.lines.length - before;
}

// ---------------- embedding ----------------
function openEmbedDialog() {
  if (!state.file) { toast('Open a song first'); return; }
  if (!state.doc.lines.length) { toast('Nothing to embed yet'); return; }
  if (!P.isApp()) { toast('Embedding into song files needs the desktop or Android app (see the GitHub releases)', 4500); return; }
  $('embedName').textContent = state.file.name;
  $('dlgEmbed').showModal();
}

async function embed(mode) {
  $('dlgEmbed').close();
  busy('Embedding lyrics...');
  try {
    const out = await P.embedLyrics(state.file.bytes, lrcText());
    let where = null;
    if (mode === 'overwrite' && state.file.path) {
      try {
        await P.writeBytes(state.file.path, out);
        where = state.file.name;
      } catch (e) {
        console.warn('overwrite failed', e);
        busy(null);
        toast("Couldn't write to the original file, so save a copy instead", 4000);
      }
    }
    if (!where) {
      busy(null);
      const ext = (state.file.name.match(/\.[a-z0-9]+$/i) || [''])[0];
      where = await P.saveBytesAs(out, P.stripExt(state.file.name) + ' (lyrics)' + ext, state.file.path);
      if (!where) return;
      where = P.baseName(where);
    } else {
      state.file.bytes = out;
    }
    setDirty(false);
    toast('Lyrics embedded in ' + where, 3500);
  } catch (e) {
    toast("Couldn't embed: " + (e.message || e), 5000);
  } finally {
    busy(null);
  }
}

// ---------------- lyrics dialog ----------------
const dlg = $('dlgLyrics');
let picked = null;

function openLyricsDialog() {
  $('qTitle').value = state.doc.meta.ti || state.tags.title || '';
  $('qArtist').value = state.doc.meta.ar || state.tags.artist || '';
  $('preview').hidden = true;
  dlg.showModal();
  if ($('qTitle').value && !$('results').children.length) $('searchForm').requestSubmit();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.tabpane')) p.hidden = p.dataset.pane !== tab.dataset.tab;
  });
}

const yearOf = r => r.year ? `<span class="year">${r.year}</span>` : '';
const keyOf = (t, a) => (String(t || '') + '|' + String(a || '').split(/,|&| feat| ft\.?/i)[0]).toLowerCase().replace(/[^\p{L}\p{N}|]+/gu, '');

$('searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('qTitle').value.trim(), artist = $('qArtist').value.trim();
  if (!title && !artist) return;
  const useGenius = geniusAvailable();   // a plain web page can't reach Genius unless its site relays it
  $('searchStatus').textContent = useGenius ? 'Searching LRCLIB and Genius...' : 'Searching LRCLIB...';
  $('results').innerHTML = '';
  $('preview').hidden = true;
  const [lr, gr] = await Promise.allSettled([
    searchLrclib({ title, artist }, state.duration),
    useGenius ? searchGenius([title, artist].filter(Boolean).join(' ')) : Promise.resolve([]),
  ]);
  const res = [];
  const genius = gr.status === 'fulfilled' ? gr.value : [];
  const years = new Map(genius.map(g => [keyOf(g.title, g.artist), g.year]));
  if (lr.status === 'fulfilled') for (const r of lr.value) {
    const text = r.syncedLyrics || r.plainLyrics || '';
    res.push({ source: 'LRCLIB', title: r.trackName, artist: r.artistName, album: r.albumName, duration: r.duration, synced: r.syncedLyrics, plain: r.plainLyrics,
      year: years.get(keyOf(r.trackName, r.artistName)) || null, rating: rating(text), instrumental: !text });
  }
  for (const g of genius) res.push({ source: 'Genius', title: g.title, artist: g.artist, album: g.album, year: g.year, url: g.url, synced: null, plain: null, rating: null });
  const errs = [];
  if (lr.status === 'rejected') errs.push(friendlyNet(lr.reason, 'LRCLIB'));
  if (gr.status === 'rejected' && !gr.reason?.botCheck) errs.push(friendlyNet(gr.reason, 'Genius'));
  if (gr.status === 'rejected' && gr.reason?.botCheck) res.push({ source: 'Genius', title: 'Search on Genius', artist: 'Genius wants a quick check first', url: gr.reason.url, botCheck: true });
  $('searchStatus').textContent = (res.length ? `${res.length} result${res.length > 1 ? 's' : ''}` : 'Nothing found. Try fewer words, or paste lyrics instead.') + (errs.length ? ' ' + errs.join(' ') : '');
  $('results').innerHTML = res.slice(0, 40).map((r, i) => {
    const kind = r.synced ? '<span class="badge synced">Synced</span>' : r.plain ? '<span class="badge">Text only</span>' : r.source === 'Genius' ? '<span class="badge">Text</span>' : '<span class="badge">Instrumental</span>';
    const rate = r.rating === 'explicit' ? '<span class="badge explicit">Explicit</span>' : r.rating === 'censored' ? '<span class="badge censored">Censored</span>' : '';
    let len = r.duration ? clock(r.duration).replace(/\.\d+$/, '') : '';
    if (r.duration && state.duration) {
      const d = Math.round(r.duration - state.duration);
      len += Math.abs(d) <= 2 ? ' <span class="good">matches your song</span>' : ` <span class="warn">${d > 0 ? '+' : ''}${d}s vs your song</span>`;
    }
    const src = `<span class="src ${r.source.toLowerCase()}">${r.source.toUpperCase()}</span>`;
    return `<button class="result" data-i="${i}">${src}<b>${escapeHtml(r.title || '')}</b>${yearOf(r)} <span class="muted">${escapeHtml(r.artist || '')}${r.album ? ' &middot; ' + escapeHtml(r.album) : ''}</span><span class="meta">${kind}${rate} ${len}</span></button>`;
  }).join('');
  $('results').onclick = async ev => {
    const b = ev.target.closest('.result');
    if (!b) return;
    for (const x of $('results').querySelectorAll('.result')) x.classList.toggle('active', x === b);
    picked = res[+b.dataset.i];
    picked.all = res;
    if (picked.source === 'Genius' && !picked.plain) {
      $('previewText').textContent = 'Getting lyrics from Genius...';
      $('preview').hidden = false;
      try {
        picked.plain = picked.botCheck ? await geniusViaWindow(picked.url) : await fetchGeniusLyrics(picked.url);
      } catch (err) {
        picked.plain = err.botCheck ? await geniusViaWindow(err.url) : null;
        if (!picked.plain && !err.botCheck) { $('previewText').textContent = err.message || String(err); return; }
      }
      if (!picked.plain) { $('previewText').textContent = 'Copy the lyrics from the Genius page, then use Paste > Paste from clipboard.'; $('useSynced').hidden = $('usePlain').hidden = $('useUncensor').hidden = true; return; }
      picked.rating = rating(picked.plain);
    }
    showPreview();
  };
});

function friendlyNet(err, name) {
  const m = String(err && err.message || err);
  return /fetch|network|connect|dns|timed? ?out|load failed/i.test(m) ? `Couldn't reach ${name}.` : `${name}: ${m}`;
}

async function geniusViaWindow(url) {
  toast(P.isApp() && !P.isMobile()
    ? 'Pass the check in the Genius window. The lyrics come back here by themselves. If it keeps failing, turn off your VPN.'
    : 'Genius opened in your browser. Pass the check (turn off your VPN if it keeps failing), copy the lyrics, then paste them here.', 7000);
  return openGeniusWindow(url);
}

function showPreview() {
  const text = picked.synced || picked.plain || '(instrumental)';
  $('previewText').textContent = text;
  $('useSynced').hidden = !picked.synced;
  $('usePlain').hidden = !picked.plain && !picked.synced;
  $('usePlain').textContent = picked.synced ? 'Use text only and time it myself' : 'Use and time it myself';
  $('useUncensor').hidden = picked.rating !== 'censored';
  $('previewNote').textContent = picked.rating === 'censored' ? 'These lyrics are censored. Uncensor looks for an uncensored version of the same song and puts the original words back, keeping these timings.' : '';
  $('preview').hidden = false;
  $('preview').scrollIntoView({ block: 'nearest' });
}

$('useUncensor').onclick = async () => {
  if (!picked) return;
  $('useUncensor').disabled = true;
  try {
    const source = await findUncensored(picked);
    if (!source) { toast("Couldn't find an uncensored version of this song", 4000); return; }
    const d = parse(picked.synced || picked.plain);
    const n = uncensor(d.lines, source);
    if (!n) { toast("The uncensored version didn't match these lyrics closely enough", 4000); return; }
    const txt = picked.synced ? format({ meta: {}, lines: d.lines }).replace(/^\[re:[^\]]*]\n/m, '') : d.lines.map(l => l.text).join('\n');
    if (picked.synced) picked.synced = txt; else picked.plain = txt;
    picked.rating = rating(txt);
    showPreview();
    toast(`Put back ${n} word${n > 1 ? 's' : ''}`, 2500);
  } finally {
    $('useUncensor').disabled = false;
  }
};

async function findUncensored(p) {
  const same = r => r !== p && keyOf(r.title, r.artist) === keyOf(p.title, p.artist);
  for (const r of p.all || []) if (same(r) && (r.synced || r.plain) && rating(r.synced || r.plain) === 'explicit') return r.plain || r.synced.replace(/\[[^\]]*]/g, '');
  try {
    const hits = await searchGenius(`${p.title} ${p.artist || ''}`);
    for (const h of hits.slice(0, 3)) {
      if (keyOf(h.title, h.artist) !== keyOf(p.title, p.artist) && hits.length > 1) continue;
      let text = null;
      try { text = await fetchGeniusLyrics(h.url); } catch (err) { if (err.botCheck) text = await geniusViaWindow(err.url); }
      if (text && rating(text) !== 'censored') return text;
    }
  } catch (err) { if (err.botCheck) return geniusViaWindow(err.url); }
  return null;
}

$('pasteClip').onclick = async () => {
  try { $('pasteText').value = await navigator.clipboard.readText(); }
  catch { $('pasteText').focus(); toast('Long-press or Ctrl+V in the box to paste', 2500); }
};

function useResult(synced) {
  if (!picked) return;
  const d = synced ? parse(picked.synced) : parse(picked.plain || stripTimes(picked.synced || ''));
  d.meta = { ...d.meta, ti: picked.title, ar: picked.artist, al: picked.album };
  replaceDoc(d);
  dlg.close();
  if (synced) autoFit({ hintSec: picked.duration ? picked.duration - state.duration : 0 });
}
function stripTimes(t) { return t.replace(/^\s*(\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?])+/gm, ''); }
$('useSynced').onclick = () => useResult(true);
$('usePlain').onclick = () => useResult(false);
$('usePaste').onclick = () => {
  const t = $('pasteText').value;
  if (!t.trim()) return;
  replaceDoc(parse(t));
  dlg.close();
};
$('openLrcFile').onclick = async () => {
  const f = await P.pickText().catch(e => { toast(e.message || String(e)); return null; });
  if (!f) return;
  replaceDoc(parse(f.text));
  dlg.close();
};

// ---------------- settings & menu ----------------
function toggle(id, key) {
  const b = $(id);
  const sync = () => b.classList.toggle('on', !!state[key]);
  b.addEventListener('click', () => {
    state[key] = !state[key];
    if (key !== 'loop') P.store(key, state[key]);
    sync();
    toast(`${b.textContent}: ${state[key] ? 'on' : 'off'}`, 1200);
    timeline.request();
  });
  sync();
  return () => b.click();
}
const toggleSnap = toggle('tSnap', 'snap');
const toggleRipple = toggle('tRipple', 'ripple');
const toggleLoop = toggle('tLoop', 'loop');
toggle('tFollow', 'follow');

const SPEEDS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.75, 2, 2.25, 2.5, 3, 3.5, 4];
$('speed').innerHTML = SPEEDS.map(v => `<option value="${v}"${v === 1 ? ' selected' : ''}>${v}x</option>`).join('');
function setSpeed(v) {
  $('speed').value = String(v);
  audio.playbackRate = v;
  toast(`Speed ${v}x`, 900);
}
function stepSpeed(dir) {
  const i = SPEEDS.indexOf(+$('speed').value);
  const n = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + dir))];
  setSpeed(n);
}
$('speed').addEventListener('change', () => { audio.playbackRate = +$('speed').value; });
$('btnPlay').onclick = togglePlay;
$('btnTap').onclick = () => tap();
$('btnOpen').onclick = $('btnOpen2').onclick = async () => openAudio(await P.pickAudio().catch(e => { toast(e.message || String(e)); return null; }));
$('btnLyrics').onclick = () => openLyricsDialog();
$('btnSave').onclick = save;
$('btnSyncAll').onclick = () => syncAll();
$('writeAudio').onclick = () => writeFromAudio();
$('setModel').innerHTML = Object.entries(MODELS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('');
$('setModel').onchange = e => { state.model = e.target.value; P.store('model', state.model); };
$('setLang').onchange = e => { state.lang = e.target.value; P.store('lang', state.lang); };
$('btnEmbed').onclick = openEmbedDialog;
$('embedOverwrite').onclick = () => embed('overwrite');
$('embedCopy').onclick = () => embed('copy');
$('zIn').onclick = () => timeline.zoomAt(1.6, timeline.x(state.time));
$('zOut').onclick = () => timeline.zoomAt(1 / 1.6, timeline.x(state.time));
$('zFit').onclick = () => timeline.fit();
for (const b of document.querySelectorAll('[data-nudge]')) b.onclick = () => nudge(+b.dataset.nudge);
$('bSetHere').onclick = () => tap({ advance: false });
$('bPlayLine').onclick = playLine;
$('bClear').onclick = clearTime;
$('bInsert').onclick = insertLine;
$('bDelete').onclick = deleteLine;
$('bUndo').onclick = undo;
$('bRedo').onclick = redo;

const menu = $('menu');
$('btnMore').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#menu')) menu.hidden = true; });
menu.addEventListener('click', async e => {
  const act = e.target.dataset.act;
  menu.hidden = true;
  if (act === 'copy') {
    if (!state.doc.lines.length) return toast('Nothing to copy yet');
    toast((await P.copyText(lrcText())) ? 'Copied LRC' : "Couldn't copy");
  } else if (act === 'write') {
    writeFromAudio();
  } else if (act === 'fit') {
    autoFit({ hintSec: 1 });
  } else if (act === 'breaks') {
    addBreaks();
  } else if (act === 'embed') {
    openEmbedDialog();
  } else if (act === 'replace') {
    openReplace();
  } else if (act === 'openLrc') {
    $('openLrcFile').click();
  } else if (act === 'settings') {
    $('setTapComp').value = state.tapComp;
    $('setSnapPx').value = state.snapPx;
    $('setGapSec').value = state.gapSec;
    $('setModel').value = state.model;
    $('setLang').value = state.lang;
    $('dlgSettings').showModal();
  } else if (act === 'keys') $('dlgKeys').showModal();
  else if (act === 'about') { $('aboutVersion').textContent = state.version ? 'v' + state.version : ''; $('dlgAbout').showModal(); }
});
$('setTapComp').onchange = e => { state.tapComp = Math.max(0, Math.min(500, +e.target.value || 0)); P.store('tapComp', state.tapComp); };
$('setSnapPx').onchange = e => { state.snapPx = Math.max(2, Math.min(40, +e.target.value || 10)); P.store('snapPx', state.snapPx); };
$('setGapSec').onchange = e => { state.gapSec = Math.max(1, Math.min(30, +e.target.value || 4)); P.store('gapSec', state.gapSec); updateGaps(); timeline.request(); };
$('resetBand').onclick = () => { setBand(DEFAULT_BAND.lo, DEFAULT_BAND.hi, true); toast('Voice band reset'); };

// ---------------- find & replace ----------------
const rOpts = () => ({ matchCase: $('repCase').checked, wholeWord: $('repWhole').checked });
function replaceCount() {
  const n = countMatches(state.doc.lines, $('repFind').value, rOpts());
  $('repCount').textContent = $('repFind').value.trim() ? `${n} match${n === 1 ? '' : 'es'}` : '';
  $('repAll').disabled = !n;
}
function openReplace() {
  if (!state.doc.lines.some(l => l.text)) { toast('No lyrics yet'); return; }
  replaceCount();
  $('dlgReplace').showModal();
  $('repFind').focus(); $('repFind').select();
}
function doReplace() {
  const find = $('repFind').value, repl = $('repWith').value;
  const before = structuredClone(state.doc);
  const r = replaceAll(state.doc.lines, find, repl, rOpts());
  if (!r.count) { replaceCount(); return; }
  history.push(before);
  setDirty(true); renderList(); timeline.request();
  replaceCount();
  toast(`Replaced ${r.count} time${r.count === 1 ? '' : 's'} in ${r.lines} line${r.lines === 1 ? '' : 's'}. Ctrl+Z to undo.`, 4000);
}
['repFind', 'repCase', 'repWhole'].forEach(id => $(id).addEventListener('input', replaceCount));
$('repAll').onclick = e => { e.preventDefault(); doReplace(); };
$('repWith').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doReplace(); } });
$('repFind').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('repWith').focus(); } });

// ---------------- keyboard ----------------
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  let handled = true;
  if (ctrl && (k === 'z' || k === 'Z')) e.shiftKey ? redo() : undo();
  else if (ctrl && (k === 'y' || k === 'Y')) redo();
  else if (ctrl && (k === 's' || k === 'S')) save();
  else if (ctrl && (k === 'o' || k === 'O')) $('btnOpen').click();
  else if (ctrl && (k === 'h' || k === 'H' || k === 'f' || k === 'F')) openReplace();
  else if (ctrl) handled = false;
  else if (k === ' ') togglePlay();
  else if (k === 'Enter' || k === 't' || k === 'T') tap();
  else if (k === 's' || k === 'S') tap({ advance: false });
  else if (k === 'ArrowUp') select(state.sel - 1);
  else if (k === 'ArrowDown') select(state.sel + 1);
  else if (k === 'ArrowLeft' || k === 'ArrowRight') nudge((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : e.altKey ? 100 : 50));
  else if (k === ',') seek(state.time - 2);
  else if (k === '.') seek(state.time + 2);
  else if (k === 'p' || k === 'P') playLine();
  else if (k === 'e' || k === 'E' || k === 'F2') { if (state.sel >= 0) editLine(state.sel); }
  else if (k === 'i' || k === 'I') insertLine();
  else if (k === 'Delete') deleteLine();
  else if (k === 'g' || k === 'G') toggleSnap();
  else if (k === 'r' || k === 'R') toggleRipple();
  else if (k === 'l' || k === 'L') toggleLoop();
  else if (k === '+' || k === '=') $('zIn').click();
  else if (k === '-' || k === '_') $('zOut').click();
  else if (k === '0') timeline.fit();
  else if (k === 'Home') seek(0);
  else if (k === 'b' || k === 'B') addBreaks();
  else if (k === 'a' || k === 'A') syncAll();
  else if (k === '[') stepSpeed(-1);
  else if (k === ']') stepSpeed(1);
  else if (k === '\\') setSpeed(1);
  else handled = false;
  if (handled) e.preventDefault();
});

// ctrl+arrow nudges 100 ms too
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest('input, textarea')) {
    e.preventDefault();
    nudge(e.key === 'ArrowLeft' ? -100 : 100);
  }
});

// ---------------- drops, start ----------------
P.onFileDrop(async ({ paths, files }) => {
  try {
    if (paths) {
      const p = paths[0];
      if (/\.(lrc|txt)$/i.test(p)) replaceDoc(parse(await window.__TAURI__.fs.readTextFile(p)));
      else openAudio(await P.readAudioPath(p));
    } else if (files) {
      const f = files[0];
      if (/\.(lrc|txt)$/i.test(f.name)) replaceDoc(parse(await f.text()));
      else openAudio({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
  } catch (e) { toast("Couldn't open that: " + (e.message || e), 5000); }
});

window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

(async () => {
  try { state.version = (await window.__TAURI__?.app?.getVersion?.()) || window.LRCSSYNC_WEB_VERSION || ''; } catch { state.version = window.LRCSSYNC_WEB_VERSION || ''; }
  if (!P.isApp()) document.body.classList.add('web');
  if (window.LRCSSYNC_USER && window.LRCSSYNC_USER.name && !$('account').textContent.trim()) $('account').textContent = window.LRCSSYNC_USER.name;
  state.version = state.version.replace(/\.0$/, '');
  if (P.isMobile()) document.body.classList.add('mobile');
  renderList();
  updateClock();
  timeline.request();
})();

// test hooks (used by the browser checks)
window.lrcsApi = { audio, openAudio, syncAll, writeFromAudio, autoFit, snapAll, listen, copySectionTiming, addBreaks, sectionAction, replaceDoc, parse, tap, nudge, select, seek, setBand, lrcText, undo, redo, timeline };
