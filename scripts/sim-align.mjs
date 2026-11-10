// Development tool: measures how well alignLines() times lyrics on simulated songs.
// It invents songs (sections, repeats, instrumental gaps), then a speech model's flawed word list for them
// (missed words, lines and whole sections, wrong words, made-up words in gaps, jittery times, and the first word
// after a silence stretched backwards), plus an imperfect "where is singing" map, and compares the line times.
//
//   node scripts/sim-align.mjs [songs=300] [path/to/other/align.js to compare against]
import { alignLines } from '../ui/js/align.js';
import { nearestSnap } from '../ui/js/voice.js';

const N = +(process.argv[2] || 300);
const other = process.argv[3] ? (await import(new URL(process.argv[3], `file://${process.cwd()}/`))).alignLines : null;

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / Math.sqrt(0.5); };
const VOCAB = ('the and you that was for are with his they this have from one had word but not what all were when your can said there use each which she how their will other about out many then them these some her would make like him into time has look two more write see number way could people than first water been call who oil its now find long down day did get come made may part over new sound take only little work know place year live back give most very after thing our just name good sentence man think say great where help through much before line right too mean old any same tell boy follow came want show also around form three small set put end does another well large must big even such because turn here why ask went men read need land different home move try kind hand picture again change off play spell air away animal house point page letter mother answer found study still learn should america world high every near add food between own below country plant last school father keep tree never start city earth eye light thought head under story saw left dont few while along might close something seem next hard open example begin life always those both paper together got group often run important until children side feet car mile night walk white sea began grow took river four carry state once book hear stop without second later miss idea enough eat face watch far indian real almost let above girl sometimes mountain cut young talk soon list song being leave family heart fire dream alone forever tonight shadow river dancing broken golden silver thunder whisper').split(' ');
const word = () => VOCAB[ri(0, VOCAB.length - 1)];

function song() {
  const kinds = [];
  const nKinds = ri(3, 5);
  for (let k = 0; k < nKinds; k++) kinds.push(Array.from({ length: ri(4, 8) }, () => Array.from({ length: ri(3, 9) }, word)));
  const order = [0, 1, 0, 2 % nKinds, 1, ri(0, nKinds - 1), 1].slice(0, ri(4, 7));
  const lines = [], words = [], sections = [];
  let t = ri(2000, 20000);
  order.forEach((k, si) => {
    if (si) t += rnd() < 0.5 ? ri(4000, 15000) : ri(900, 2200);
    const sec = { first: lines.length };
    for (const lw of kinds[k]) {
      const start = t;
      const ws = [];
      for (const w of lw) { const d = ri(220, 460); ws.push({ text: w, start: t, end: t + d - 30 }); t += d; }
      lines.push({ text: lw.join(' '), t: start, end: t, sec: si, words: ws });
      t += ri(250, 1500);
    }
    sec.last = lines.length;
    sections.push(sec);
  });
  // what the "where is singing" detector sees
  let regions = [];
  for (const l of lines) {
    const last = regions[regions.length - 1];
    if (last && l.t - last[1] < 250) last[1] = l.end; else regions.push([l.t, l.end]);
  }
  regions = regions.map(([a, b]) => [Math.max(0, a + ri(-40, 40)), b + ri(-60, 120)]);
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 900 && rnd() < 0.3) last[1] = r[1]; else merged.push(r.slice());
  }
  regions = merged;
  for (let i = regions.length - 1; i > 0; i--) { // instruments mistaken for singing in the long gaps
    const gap = regions[i][0] - regions[i - 1][1];
    if (gap > 5000 && rnd() < 0.3) { const a = regions[i - 1][1] + ri(800, gap - 2500); regions.splice(i, 0, [a, a + ri(500, 1500)]); }
  }
  const onsets = [...regions.map(r => r[0]), ...lines.filter(() => rnd() < 0.7).map(l => l.t + ri(-50, 50)), ...lines.flatMap(l => l.words.filter(() => rnd() < 0.2).map(w => w.start))].sort((a, b) => a - b);
  const voice = { regions, starts: regions.map(r => r[0]), onsets, snaps: [...new Set([...regions.map(r => r[0]), ...onsets])].sort((a, b) => a - b) };
  // what the speech model heard
  const heard = [];
  const lostSec = new Set(sections.map((_, i) => i).filter(() => rnd() < 0.15));
  lines.forEach((l, i) => {
    if (lostSec.has(l.sec)) { l.kind = 'whole section unheard'; return; }
    if (rnd() < 0.12) { l.kind = 'line unheard'; return; }
    l.kind = 'heard';
    const gapBefore = i ? l.t - lines[i - 1].end : l.t;
    l.words.forEach((w, k) => {
      if (rnd() < 0.15) return;
      const h = { text: rnd() < 0.12 ? word() : w.text, start: w.start + Math.round(gauss() * 100), end: w.end + Math.round(gauss() * 60) };
      if (k === 0 && gapBefore >= 600 && rnd() < 0.6) h.start = Math.round(w.start - gapBefore * (0.2 + rnd() * 0.7));
      if (h.end <= h.start) h.end = h.start + 120;
      heard.push(h);
    });
  });
  for (let i = 1; i < lines.length; i++) { // made-up words over instrumentals
    const gap = lines[i].t - lines[i - 1].end;
    if (gap > 6000 && rnd() < 0.4) for (let k = 0, n = ri(3, 6); k < n; k++) { const s = lines[i - 1].end + 1000 + k * 500; heard.push({ text: word(), start: s, end: s + 300 }); }
  }
  heard.sort((a, b) => a.start - b.start);
  return { lines, heard, voice };
}

function snapAll(times, lines, voice, radius = 260) { // same as the app's "snap to singing" step
  let last = -Infinity;
  return times.map(t0 => {
    if (t0 == null) return null;
    let t = t0;
    const s = nearestSnap(voice.starts, t, radius, radius * 0.7) ?? nearestSnap(voice.snaps, t, radius * 0.6, radius * 0.4);
    if (s != null && s > last + 50) t = s;
    if (t <= last) t = last + 50;
    last = t;
    return t;
  });
}

function measure(fn, withVoice) {
  seed = 12345;
  const errs = [], kinds = {};
  for (let s = 0; s < N; s++) {
    const { lines, heard, voice } = song();
    const res = fn(lines.map(l => ({ text: l.text })), heard, withVoice ? { voice } : undefined);
    const times = snapAll(res.map(r => r.t), lines, voice);
    lines.forEach((l, i) => { const e = times[i] == null ? 30000 : Math.abs(times[i] - l.t); errs.push(e); (kinds[l.kind] ||= []).push(e); });
  }
  errs.sort((a, b) => a - b);
  const pct = x => (100 * errs.filter(e => e <= x).length / errs.length).toFixed(1) + '%';
  if (process.env.BY_KIND) for (const [k, a] of Object.entries(kinds)) { a.sort((x, y) => x - y); console.log('   ', k.padEnd(22), 'lines', String(a.length).padStart(5), ' median', String(a[a.length >> 1]).padStart(5), ' within 300 ms', (100 * a.filter(e => e <= 300).length / a.length).toFixed(0) + '%', ' within 1 s', (100 * a.filter(e => e <= 1000).length / a.length).toFixed(0) + '%'); }
  return { lines: errs.length, median: errs[errs.length >> 1], mean: Math.round(errs.reduce((a, b) => a + b, 0) / errs.length), within150: pct(150), within300: pct(300), within1s: pct(1000), worse3s: (100 - parseFloat(pct(3000))).toFixed(1) + '%' };
}

console.log('this version      ', JSON.stringify(measure(alignLines, true)));
console.log('this, no voice map', JSON.stringify(measure(alignLines, false)));
if (other) console.log('other version     ', JSON.stringify(measure(other, false)));
