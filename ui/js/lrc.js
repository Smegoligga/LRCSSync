// LRC parsing and writing.

const TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?]/g;
const META = /^\s*\[([a-zA-Z#]+):([^\]]*)]\s*$/;
const WORD_TIME = /<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g;

const META_KEYS = new Set(['ti', 'ar', 'al', 'au', 'by', 'length', 'offset', 're', 've', 'tool', '#', 'la', 'id']);
const SECTION_WORDS = 'chorus|verse|pre-?chorus|post-?chorus|hook|bridge|intro|outro|refrain|interlude|break|breakdown|drop|instrumental|skit|part|coda|vamp|ad-?libs?';

/** "[Chorus]", "[Verse 2: Artist]", "(Hook)", "Chorus:" -> "Chorus", "Verse 2", "Hook"; else null. */
export function sectionHeader(t) {
  const m = t.match(new RegExp(`^[\\[(]?\\s*((?:${SECTION_WORDS})(?:\\s*\\d+)?)\\s*(?::[^\\])]*)?[\\])]?\\s*:?$`, 'i'));
  if (!m) return null;
  if (!/^[\[(]/.test(t) && !/:$/.test(t) && !/^\w+(\s*\d+)?$/.test(t)) return null;
  const name = m[1].replace(/\s+/g, ' ').trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

let nextId = 1;
export function newLine(t, text) {
  return { id: nextId++, t: t == null ? null : Math.max(0, Math.round(t)), text: text ?? '' };
}

function toMs(m, s, f) {
  let frac = 0;
  if (f != null) frac = f.length === 1 ? +f * 100 : f.length === 2 ? +f * 10 : +f;
  return (+m * 60 + +s) * 1000 + frac;
}

/** True when the text has at least one LRC line timestamp. */
export function isSynced(text) {
  TIME.lastIndex = 0;
  return text.split(/\r\n|\r|\n/).some(l => /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?]/.test(l));
}

/**
 * Parses LRC or plain text. Returns { meta, lines, synced }.
 * Plain text gives untimed lines (t = null). [offset:] is applied to the times and dropped.
 */
export function parse(text) {
  const meta = {};
  const lines = [];
  const raw = String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  if (!isSynced(text ?? '')) {
    let sec = false, label = null;
    for (const l of raw) {
      const m = l.match(META);
      if (m && META_KEYS.has(m[1].toLowerCase())) { meta[m[1].toLowerCase()] = m[2].trim(); continue; }
      const t = l.trim();
      if (!t) { if (lines.length) sec = true; continue; }
      const h = sectionHeader(t);
      if (h) { label = h; sec = true; continue; }
      const ln = newLine(null, t);
      if (sec || label) { ln.sec = true; if (label) ln.label = label; }
      sec = false; label = null;
      lines.push(ln);
    }
    return { meta, lines, synced: false };
  }
  let offset = 0;
  for (const l of raw) {
    const stamps = [];
    let rest = l;
    let m;
    const lead = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?]/;
    while ((m = rest.match(lead))) {
      stamps.push(toMs(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    if (stamps.length) {
      const body = rest.replace(WORD_TIME, '').replace(/\s+/g, ' ').trim();
      for (const s of stamps) lines.push(newLine(s, body));
      continue;
    }
    const mm = l.match(META);
    if (mm && META_KEYS.has(mm[1].toLowerCase())) {
      const key = mm[1].toLowerCase();
      if (key === 'offset') offset = parseInt(mm[2], 10) || 0;
      else meta[key] = mm[2].trim();
    }
  }
  // Positive offset = lyrics shown earlier
  if (offset) for (const l of lines) l.t = Math.max(0, l.t - offset);
  lines.sort((a, b) => a.t - b.t);
  return { meta, lines, synced: true };
}

export function stamp(ms) {
  if (ms == null) return '--:--.--';
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Short clock for the UI: m:ss.cc */
export function clock(seconds) {
  if (!isFinite(seconds)) seconds = 0;
  const cs = Math.max(0, Math.round(seconds * 100));
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Writes LRC. Timed lines are sorted by time; untimed lines are kept at the end without a stamp. */
export function format(doc, { version } = {}) {
  const out = [];
  const meta = doc.meta || {};
  for (const k of ['ti', 'ar', 'al', 'au', 'by']) if (meta[k]) out.push(`[${k}:${meta[k]}]`);
  if (meta.length) out.push(`[length:${meta.length}]`);
  out.push(`[re:LRCSSync${version ? ' ' + version : ''}]`);
  const timed = doc.lines.filter(l => l.t != null).slice().sort((a, b) => a.t - b.t);
  const untimed = doc.lines.filter(l => l.t == null);
  for (const l of timed) out.push(`[${stamp(l.t)}]${l.text}`);
  for (const l of untimed) out.push(l.text);
  return out.join('\n') + '\n';
}

/** Index of the line playing at `ms` (last timed line at or before it), or -1. */
export function lineAt(lines, ms) {
  let best = -1;
  let bestT = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].t;
    if (t != null && t <= ms && t >= bestT) { best = i; bestT = t; }
  }
  return best;
}

/** Start of the next timed line after index i (by time), or null. */
export function nextTime(lines, i) {
  const t = lines[i]?.t;
  if (t == null) return null;
  let n = null;
  for (let j = 0; j < lines.length; j++) {
    if (j === i) continue;
    const u = lines[j].t;
    if (u != null && (u > t || (u === t && j > i)) && (n == null || u < n)) n = u;
  }
  return n;
}

/** Nearest timed neighbours in list order: { prev, next } times (or null). */
export function neighbours(lines, i) {
  let prev = null, next = null;
  for (let j = i - 1; j >= 0; j--) if (lines[j].t != null) { prev = lines[j].t; break; }
  for (let j = i + 1; j < lines.length; j++) if (lines[j].t != null) { next = lines[j].t; break; }
  return { prev, next };
}
