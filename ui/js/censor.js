// Spots censored lyrics ("n-", "f***", "sh*t", "b—h") and puts the original words back using an uncensored
// version of the same song, keeping the censored version's timings.
import { normWord, wordSim } from './align.js';

// a word with masking characters inside or at the end: f***, sh*t, b—h, n-, f#@k
const MASK = /^([\p{L}]{0,6})([*#@$%!_]{1,}|[-–—]{1,3})([\p{L}]{0,4})$/u;
const STRONG = ['fuck', 'shit', 'bitch', 'nigg', 'pussy', 'cunt', 'motherf', 'dick', 'whore', 'cock'];

function words(line) { return String(line).split(/(\s+)/); }

/** A token that looks censored (not ordinary punctuation like "-" or "—" between words). */
export function isMasked(tok) {
  const t = tok.replace(/^[("'“‘]+|[)"'”’,.!?;:]+$/g, '');
  if (!t || /^[-–—*]+$/.test(t)) return false;
  const m = t.match(MASK);
  if (!m) return false;
  if (/[-–—]/.test(m[2]) && !m[1]) return false;      // "-word"
  if (/^-+$/.test(m[2]) && m[3]) return false;        // "re-do", "x-ray": normal hyphenated words
  return true;
}

/** 'explicit' | 'censored' | null (can't tell). */
export function rating(text) {
  const toks = String(text || '').split(/\s+/);
  if (toks.some(isMasked)) return 'censored';
  const n = toks.map(normWord);
  if (n.some(w => STRONG.some(s => w.startsWith(s)))) return 'explicit';
  return null;
}

function maskMatches(mask, word) {
  const m = mask.replace(/^[("'“‘]+|[)"'”’,.!?;:]+$/g, '').match(MASK);
  if (!m) return false;
  const w = normWord(word), pre = normWord(m[1]), post = normWord(m[3]);
  return w.length > pre.length + post.length && w.startsWith(pre) && w.endsWith(post) && w.length >= 2;
}

/**
 * Restores censored words in `lines` ([{ text, ... }], changed in place) from `sourceText` (uncensored lyrics).
 * Returns how many words were restored.
 */
export function uncensor(lines, sourceText) {
  const src = String(sourceText).split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^\[.*\]$/.test(s));
  const srcWords = src.map(s => s.split(/\s+/));
  let fixed = 0, from = 0;
  for (const ln of lines) {
    const toks = words(ln.text);
    if (!toks.some(t => t.trim() && isMasked(t))) {
      // still advance through the source so we stay in order
      const k = bestLine(ln.text, srcWords, from);
      if (k >= 0) from = k + 1;
      continue;
    }
    const k = bestLine(ln.text, srcWords, from);
    if (k < 0) continue;
    from = k + 1;
    const sw = srcWords[k];
    // walk both lines; masked tokens take the source word at the matching place
    const lw = toks.filter(t => t.trim());
    let j = 0;
    const out = lw.map(t => {
      if (isMasked(t)) {
        for (let q = j; q < Math.min(sw.length, j + 3); q++) {
          if (maskMatches(t, sw[q])) {
            j = q + 1;
            fixed++;
            const trail = (t.match(/[)"'”’,.!?;:]+$/) || [''])[0];
            const lead = (t.match(/^[("'“‘]+/) || [''])[0];
            return lead + sw[q].replace(/^[("'“‘]+|[)"'”’,.!?;:]+$/g, '') + trail;
          }
        }
        return t;
      }
      for (let q = j; q < Math.min(sw.length, j + 3); q++) if (wordSim(normWord(t), normWord(sw[q])) > 0) { j = q + 1; break; }
      return t;
    });
    ln.text = out.join(' ');
  }
  return fixed;
}

function bestLine(text, srcWords, from) {
  const mine = String(text).split(/\s+/).filter(t => t && !isMasked(t)).map(normWord).filter(Boolean);
  let best = -1, bestS = 0;
  for (let k = from; k < Math.min(srcWords.length, from + 12); k++) {
    const theirs = srcWords[k].map(normWord);
    let s = 0;
    for (const w of mine) if (theirs.some(x => wordSim(w, x) > 0)) s++;
    const score = mine.length ? s / mine.length : 0;
    if (score > bestS + 1e-9) { bestS = score; best = k; }
  }
  return bestS >= 0.5 ? best : -1;
}
