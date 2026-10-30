import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJs } from '../ui/js/spectro.js';
import { analyzeBand, nearestSnap, hzToRow, rowToHz } from '../ui/js/voice.js';

const SR = 16000;
function song() {
  // 0-2 s low "bass" only, 2-4 s voice-like tones, 4-6 s bass, 6-7.5 s voice, then bass
  const n = SR * 9, x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = 0.3 * Math.sin(2 * Math.PI * 60 * t);
    const voiced = (t >= 2 && t < 4) || (t >= 6 && t < 7.5);
    if (voiced) x[i] += 0.25 * Math.sin(2 * Math.PI * 440 * t) + 0.15 * Math.sin(2 * Math.PI * 880 * t) + 0.08 * Math.sin(2 * Math.PI * 1320 * t);
  }
  return x;
}

test('row/hz mapping is inverse', () => {
  const spec = { fMin: 50, fMax: 8000, bins: 128 };
  for (const hz of [100, 440, 3000]) assert.ok(Math.abs(rowToHz(spec, hzToRow(spec, hz)) - hz) < 0.01);
});

test('finds sung regions and their starts in the voice band', () => {
  const spec = analyzeJs(song(), SR);
  assert.equal(spec.frames, 900);
  const v = analyzeBand(spec, 150, 4000);
  assert.equal(v.regions.length, 2, JSON.stringify(v.regions));
  assert.ok(Math.abs(v.regions[0][0] - 2000) <= 60, JSON.stringify(v.regions));
  assert.ok(Math.abs(v.regions[0][1] - 4000) <= 80, JSON.stringify(v.regions));
  assert.ok(Math.abs(v.regions[1][0] - 6000) <= 60, JSON.stringify(v.regions));
  assert.equal(nearestSnap(v.snaps, 2100, 200) !== null, true);
  assert.ok(Math.abs(nearestSnap(v.snaps, 6150, 300) - 6000) <= 60);
});

test('a band that excludes the voice finds nothing sung', () => {
  const spec = analyzeJs(song(), SR);
  const v = analyzeBand(spec, 50, 90);
  // the bass is constant so there is no clear start inside the voice regions
  assert.equal(v.regions.filter(r => r[0] > 1000).length, 0, JSON.stringify(v.regions));
});

test('nearestSnap respects the window', () => {
  const s = [1000, 2000, 3000];
  assert.equal(nearestSnap(s, 2100, 50), null);
  assert.equal(nearestSnap(s, 2100, 150), 2000);
  assert.equal(nearestSnap(s, 2900, 50, 150), 3000);
  assert.equal(nearestSnap([], 10, 100), null);
});
