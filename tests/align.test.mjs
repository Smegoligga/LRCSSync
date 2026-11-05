import test from 'node:test';
import assert from 'node:assert/strict';
import { alignLines, wordsToLines, wordSim } from '../ui/js/align.js';
import { fitTiming, lyricMask, applyFit } from '../ui/js/fit.js';

// heard words with times: each lyric word 400 ms apart starting at line times
function hear(lines, starts, mutate = w => w) {
  const out = [];
  lines.forEach((l, i) => l.split(' ').forEach((w, k) => out.push(mutate({ text: w, start: starts[i] + k * 400, end: starts[i] + k * 400 + 300 }, i, k))));
  return out.filter(Boolean);
}

test('word similarity', () => {
  assert.equal(wordSim('hello', 'hello'), 1);
  assert.ok(wordSim('sleeping', 'sleepin') > 0.8);
  assert.equal(wordSim('dog', 'cat'), 0);
});

test('aligns clean transcript exactly', () => {
  const lyr = ['hello darkness my old friend', 'I have come to talk with you again', 'because a vision softly creeping'];
  const starts = [2000, 6500, 11000];
  const r = alignLines(lyr.map(text => ({ text })), hear(lyr, starts));
  assert.deepEqual(r.map(x => x.t), starts);
  assert.ok(r.every(x => x.conf === 1));
});

test('survives misheard, missing and extra words', () => {
  const lyr = ['hello darkness my old friend', "I've come to talk with you again", 'because a vision softly creeping', 'left its seeds while I was sleeping'];
  const starts = [2000, 6500, 11000, 16000];
  let words = hear(lyr, starts, (w, i, k) => {
    if (i === 0 && k === 1) return { ...w, text: 'darknes' };      // misheard
    if (i === 2 && k === 0) return null;                            // first word missed
    if (i === 3 && k === 2) return { ...w, text: 'seats' };         // wrong
    return w;
  });
  words = [{ text: 'yeah', start: 500, end: 700 }, ...words, { text: 'uh', start: 9000, end: 9100 }]; // ad-libs
  const r = alignLines(lyr.map(text => ({ text })), words);
  r.forEach((x, i) => assert.ok(Math.abs(x.t - starts[i]) <= 450, `line ${i}: ${x.t} vs ${starts[i]}`));
  assert.ok(r[2].conf < 1 && r[2].conf > 0.5);
});

test('repeated chorus keeps order', () => {
  const lyr = ['verse one', 'chorus line a', 'chorus line b', 'verse two here', 'chorus line a', 'chorus line b'];
  const starts = [1000, 5000, 7000, 12000, 20000, 22000];
  const r = alignLines(lyr.map(text => ({ text })), hear(lyr, starts));
  assert.deepEqual(r.map(x => x.t), starts);
});

test('unheard line is spread between neighbours', () => {
  const lyr = ['one two three', 'four five six', 'seven eight nine'];
  const starts = [1000, 5000, 9000];
  const words = hear(lyr, starts).filter(w => !['four', 'five', 'six'].includes(w.text));
  const r = alignLines(lyr.map(text => ({ text })), words);
  assert.equal(r[1].conf, 0);
  assert.ok(r[1].t > 1000 && r[1].t < 9000, String(r[1].t));
});

test('words to lines breaks at pauses', () => {
  const w = [['hello', 0], ['there', 300], ['friend.', 600], ['how', 2000], ['are', 2300], ['you', 2600]].map(([text, s]) => ({ text, start: s, end: s + 250 }));
  assert.deepEqual(wordsToLines(w), [{ t: 0, text: 'Hello there friend' }, { t: 2000, text: 'How are you' }]);
});

test('fit finds an extended intro shift and a small stretch', () => {
  const hop = 10, frames = 9000; // 90 s
  const lines = [];
  for (let i = 0; i < 18; i++) lines.push({ t: 3000 + i * 3500 + (i % 3) * 400, text: 'some words in this line' });
  // the recording has a 12.3 s longer intro
  const truth = { offset: 12300, scale: 1 };
  const level = lyricMask(lines, frames, hop, truth.scale, truth.offset);
  for (let i = 0; i < frames; i++) level[i] = Math.min(1, level[i] * 0.8 + Math.random() * 0.25);
  const f = fitTiming(lines, level, hop, { durationHintMs: 12300 });
  assert.ok(f.better, JSON.stringify(f));
  assert.ok(Math.abs(f.offset - 12300) <= 60, JSON.stringify(f));
  assert.equal(applyFit(1000, { offset: 500, scale: 1 }), 1500);

  const level2 = lyricMask(lines, frames, hop, 1.02, -800);
  const f2 = fitTiming(lines, level2, hop, { durationHintMs: 2000 });
  assert.equal(f2.scale, 1.02);
  assert.ok(Math.abs(f2.offset + 800) <= 120, JSON.stringify(f2));
});

test('fit leaves already-matching lyrics alone', () => {
  const hop = 10, frames = 6000;
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push({ t: 2000 + i * 4500, text: 'a b c d' });
  const level = lyricMask(lines, frames, hop);
  const f = fitTiming(lines, level, hop);
  assert.equal(f.better, false, JSON.stringify(f));
});
