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

test('words to lines: breaks before a capitalised word, not before I / I\'m', () => {
  const said = 'I keep on falling down And I\'m never coming back Tonight I know Paris is calling';
  const w = said.split(' ').map((t, i) => ({ text: t, start: i * 300, end: i * 300 + 280 }));
  assert.deepEqual(wordsToLines(w).map(l => l.text),
    ['I keep on falling down', "And I'm never coming back", 'Tonight I know', 'Paris is calling']);
});

test('words to lines: breaks where singing starts again after a breath', () => {
  const said = 'we were young we were free';
  const w = said.split(' ').map((t, i) => ({ text: t, start: i * 300 + (i >= 3 ? 150 : 0), end: i * 300 + 260 + (i >= 3 ? 150 : 0) }));
  assert.deepEqual(wordsToLines(w).map(l => l.text), ['We were young we were free']);
  assert.deepEqual(wordsToLines(w, { starts: [0, 1040] }).map(l => [l.t, l.text]), [[0, 'We were young'], [1050, 'We were free']]);
});

// --- with a map of where the singing is ---
function sung(lines, starts) {
  // one region per line: from its start to the end of its last word
  return starts.map((s, i) => [s, s + lines[i].split(' ').length * 400]);
}

test('first word stretched back into a silence starts where the singing does', () => {
  const lyr = ['hello darkness my old friend', 'I have come to talk with you again', 'because a vision softly creeping'];
  const starts = [2000, 9000, 16000];
  // the speech model puts the first word of lines 2 and 3 seconds too early, inside the instrumental gap
  const words = hear(lyr, starts, (w, i, k) => (i > 0 && k === 0 ? { ...w, start: w.start - 2600 } : w));
  const regions = sung(lyr, starts);
  const plain = alignLines(lyr.map(text => ({ text })), words);
  assert.ok(Math.abs(plain[1].t - 9000) <= 500, 'without the map the over-long word is still pulled in: ' + plain[1].t);
  const r = alignLines(lyr.map(text => ({ text })), words, { voice: { regions, starts: regions.map(x => x[0]), onsets: [] } });
  assert.deepEqual(r.map(x => x.t), starts);
});

test('a word that lasts absurdly long is taken to end on time', () => {
  const lyr = ['one two three four', 'five six seven eight'];
  const starts = [1000, 8000];
  const words = hear(lyr, starts, (w, i, k) => (i === 1 && k === 0 ? { ...w, start: w.start - 3000 } : w));
  const r = alignLines(lyr.map(text => ({ text })), words);
  assert.ok(Math.abs(r[1].t - 8000) <= 500, String(r[1].t));
});

test('an unheard section is placed in the singing, not in the instrumental gap before it', () => {
  const verse1 = ['alpha bravo charlie delta echo', 'foxtrot golf hotel india juliet', 'kilo lima mike november oscar'];
  const chorus = ['papa quebec romeo sierra tango', 'uniform victor whiskey xray yankee', 'zulu amber birch cedar dune'];
  const verse2 = ['jade kelp lark moss north', 'opal pine quill reed sage'];
  const lyr = [...verse1, ...chorus, ...verse2];
  const starts = [5000, 7500, 10000, /* 8 s of guitar */ 20000, 22500, 25000, 28000, 30500];
  const words = hear(lyr, starts).filter(w => !chorus.join(' ').split(' ').includes(w.text));
  const regions = sung(lyr, starts);
  const voice = { regions, starts: regions.map(x => x[0]), onsets: [] };
  const plain = alignLines(lyr.map(text => ({ text })), words);
  assert.ok(plain[3].t < 16000, 'by the clock alone the chorus starts in the gap: ' + plain[3].t);
  const r = alignLines(lyr.map(text => ({ text })), words, { voice });
  [3, 4, 5].forEach(i => assert.ok(Math.abs(r[i].t - starts[i]) <= 300, `line ${i}: ${r[i].t} vs ${starts[i]}`));
  assert.ok(r.slice(3, 6).every(x => x.conf === 0));
});

test('unheard lines at the very start are stepped back through the singing', () => {
  const lyr = ['one two three four', 'five six seven eight', 'nine ten eleven twelve', 'red green blue pink', 'north south east west'];
  const starts = [3000, 5000, 7000, 9000, 11000];
  const words = hear(lyr, starts).filter(w => w.start >= 7000);
  const regions = sung(lyr, starts);
  const r = alignLines(lyr.map(text => ({ text })), words, { voice: { regions, starts: regions.map(x => x[0]), onsets: [] } });
  assert.ok(Math.abs(r[0].t - 3000) <= 400 && Math.abs(r[1].t - 5000) <= 400, JSON.stringify(r.map(x => x.t)));
});
