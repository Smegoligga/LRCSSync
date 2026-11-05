// Find and replace across all lyric lines (e.g. a word the speech model spells wrong every time).

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The search as a RegExp, or null if there's nothing to find. */
export function findRegex(find, { matchCase = false, wholeWord = true } = {}) {
  const f = String(find || '');
  if (!f.trim()) return null;
  let src = escapeRe(f);
  // whole word: not glued to letters, digits or apostrophes on either side
  if (wholeWord) src = `(?<![\\p{L}\\p{N}'’])${src}(?![\\p{L}\\p{N}'’])`;
  return new RegExp(src, 'gu' + (matchCase ? '' : 'i'));
}

/** Without "match case", the replacement follows the case of what it replaces: word -> new, Word -> New, WORD -> NEW. */
function followCase(found, repl) {
  if (!repl) return repl;
  const letters = found.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return repl.toUpperCase();
  const first = letters[0];
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

/** How many times `find` appears in the lines' text. */
export function countMatches(lines, find, opts) {
  const re = findRegex(find, opts);
  if (!re) return 0;
  let n = 0;
  for (const l of lines) n += (String(l.text || '').match(re) || []).length;
  return n;
}

/** Replaces in place. Returns { count, lines: number of lines changed }. */
export function replaceAll(lines, find, repl, opts = {}) {
  const re = findRegex(find, opts);
  if (!re) return { count: 0, lines: 0 };
  let count = 0, changed = 0;
  for (const l of lines) {
    const before = String(l.text || '');
    const after = before.replace(re, m => { count++; return opts.matchCase ? repl : followCase(m, repl); })
      .replace(/\s{2,}/g, ' ').trim();                      // replacing with nothing leaves no double spaces
    if (after !== before) { l.text = after; changed++; }
  }
  return { count, lines: changed };
}
