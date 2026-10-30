import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, format, stamp, lineAt, nextTime, neighbours, clock } from '../ui/js/lrc.js';

test('parses synced lrc with meta, offsets and multi stamps', () => {
  const d = parse('[ti:Song]\n[ar:Someone]\n[offset:+500]\n[00:10.00][00:30.5]Chorus\n[00:20.123]Verse <00:20.50>word\n\n[01:02]\n');
  assert.equal(d.synced, true);
  assert.equal(d.meta.ti, 'Song');
  assert.equal(d.meta.ar, 'Someone');
  assert.deepEqual(d.lines.map(l => [l.t, l.text]), [[9500, 'Chorus'], [19623, 'Verse word'], [30000, 'Chorus'], [61500, '']]);
});

test('plain text gives untimed lines', () => {
  const d = parse('Line one\n\n  Line two  \r\nLine three');
  assert.equal(d.synced, false);
  assert.deepEqual(d.lines.map(l => [l.t, l.text]), [[null, 'Line one'], [null, 'Line two'], [null, 'Line three']]);
});

test('stamp and clock', () => {
  assert.equal(stamp(0), '00:00.00');
  assert.equal(stamp(61234), '01:01.23');
  assert.equal(stamp(61235), '01:01.24');
  assert.equal(stamp(3599999), '60:00.00');
  assert.equal(stamp(null), '--:--.--');
  assert.equal(clock(83.456), '1:23.46');
});

test('format round trip and untimed lines', () => {
  const d = parse('[ti:A]\n[00:05.00]one\n[00:01.50]zero\n');
  d.lines.push({ id: 99, t: null, text: 'later' });
  const out = format(d, { version: '0.1' });
  assert.equal(out, '[ti:A]\n[re:LRCSSync 0.1]\n[00:01.50]zero\n[00:05.00]one\nlater\n');
  const again = parse(out);
  assert.deepEqual(again.lines.map(l => l.t), [1500, 5000]);
});

test('lineAt, nextTime, neighbours', () => {
  const lines = [{ t: 1000 }, { t: null }, { t: 5000 }, { t: 9000 }];
  assert.equal(lineAt(lines, 500), -1);
  assert.equal(lineAt(lines, 1000), 0);
  assert.equal(lineAt(lines, 6000), 2);
  assert.equal(nextTime(lines, 0), 5000);
  assert.equal(nextTime(lines, 3), null);
  assert.deepEqual(neighbours(lines, 1), { prev: 1000, next: 5000 });
  assert.deepEqual(neighbours(lines, 0), { prev: null, next: 5000 });
});
