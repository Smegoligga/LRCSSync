import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../ui/js/lrc.js';
import { findSections, instrumentalGaps, audioFeatures, findRepeat, mapLines, similarity } from '../ui/js/sections.js';
import { analyzeJs } from '../ui/js/spectro.js';

const brief = s => s.map(x => [x.start, x.end, x.label, x.n, x.of]);

test('sections from headers and blank lines', () => {
  const d = parse('[Verse 1]\na\nb\n\n[Chorus]\nc\nd\n\n[Verse 2]\ne\nf\n\n[Chorus]\nc\nd\n\nbridge line\nbridge two');
  assert.deepEqual(brief(findSections(d.lines)), [
    [0, 2, 'Verse 1', 1, 1], [2, 4, 'Chorus', 1, 2], [4, 6, 'Verse 2', 1, 1], [6, 8, 'Chorus', 2, 2], [8, 10, 'Verse 3', 1, 1],
  ]);
  const s = findSections(d.lines);
  assert.equal(s[1].group, s[3].group);
  assert.notEqual(s[0].group, s[2].group);
});

test('sections from repeated lines in synced lyrics without markers', () => {
  const lrc = ['v1', 'v2', 'v3', 'c1', 'c2', 'c3', 'w1', 'w2', 'c1', 'c2', 'c3', '', 'c1', 'c2', 'c3', 'end']
    .map((t, i) => `[00:${String(i * 3).padStart(2, '0')}.00]${t}`).join('\n');
  const s = findSections(parse(lrc).lines);
  const ch = s.filter(x => x.label === 'Chorus');
  assert.deepEqual(ch.map(x => [x.start, x.end, x.n, x.of]), [[3, 6, 1, 3], [8, 11, 2, 3], [12, 15, 3, 3]]);
  assert.deepEqual(s.filter(x => x.label.startsWith('Verse')).map(x => [x.start, x.end]), [[0, 3], [6, 8], [15, 16]]);
});

test('similar but not identical choruses group together', () => {
  assert.ok(similarity(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'x']) >= 0.6);
  const d = parse('[Chorus]\na\nb\nc\nd\n\n[Verse]\nq\nr\n\n[Chorus]\na\nb\nc\nzz');
  const s = findSections(d.lines);
  assert.equal(s[0].group, s[2].group);
  assert.equal(s[2].n, 2);
});

test('instrumental gaps', () => {
  const g = instrumentalGaps([[5000, 20000], [21000, 40000], [50000, 60000]], 70000, 4000);
  assert.deepEqual(g, [{ start: 0, end: 5000 }, { start: 40000, end: 50000 }, { start: 60000, end: 70000 }]);
});

test('mapLines aligns by text, falls back to position', () => {
  assert.deepEqual(mapLines(['a', 'b', 'c'], ['a', 'b', 'c']), [0, 1, 2]);
  assert.deepEqual(mapLines(['a', 'b', 'c'], ['a', 'x', 'c']), [0, 1, 2]);
  assert.deepEqual(mapLines(['a', 'b', 'c', 'd'], ['a', 'c', 'd']), [0, 2, 3]);
});

test('finds where a chorus repeats in the audio', () => {
  // Chords: verse uses one progression, chorus another; chorus at 4s, 16s and 28s
  const SR = 16000, dur = 36;
  const chord = (notes, t) => notes.reduce((s, n) => s + Math.sin(2 * Math.PI * 220 * Math.pow(2, n / 12) * t), 0) / notes.length;
  const verse = [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]];
  const chorus = [[9, 12, 16], [2, 5, 9], [4, 8, 11], [9, 12, 16], [5, 9, 12], [7, 11, 14]];
  const x = new Float32Array(SR * dur);
  const chorusAt = [4, 16, 28];
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const c = chorusAt.find(s => t >= s && t < s + 6);
    let v;
    if (c != null) v = chord(chorus[Math.floor(t - c)], t);
    else v = chord(verse[Math.floor(t * 2) % 4], t) * 0.8 + 0.05 * Math.sin(2 * Math.PI * 3000 * t);
    x[i] = v * 0.3;
  }
  const feat = audioFeatures(analyzeJs(x, SR));
  // chorus 1 is timed at 4.0-10.0 s; look for the next one after 10 s, then the one after that
  const r2 = findRepeat(feat, 4000, 10000, 10000, 30000);
  assert.ok(Math.abs(r2.start - 16000) <= 150, JSON.stringify(r2));
  const r3 = findRepeat(feat, 4000, 10000, 22000, 31000);
  assert.ok(Math.abs(r3.start - 28000) <= 150, JSON.stringify(r3));
  assert.ok(r2.score > 0.8, String(r2.score));
});
