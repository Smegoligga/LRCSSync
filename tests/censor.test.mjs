import test from 'node:test';
import assert from 'node:assert/strict';
import { rating, isMasked, uncensor } from '../ui/js/censor.js';

test('spots censored words, not normal hyphens', () => {
  for (const t of ['f***', 'sh*t,', 'b—h', 'n-', 'f#@k', '(n—)', 'mother-']) assert.ok(isMasked(t), t);
  for (const t of ['-', '—', 're-do', 'x-ray', 'hello', '***', 'twenty-one']) assert.ok(!isMasked(t), t);
  assert.equal(rating('Hello world\nI said f*** that'), 'censored');
  assert.equal(rating('Hello world\nI said fuck that'), 'explicit');
  assert.equal(rating('Hello world\nnothing here'), null);
});

test('uncensor restores words from another version and keeps everything else', () => {
  const lines = [
    { t: 1000, text: 'Look at all these n- in here' },
    { t: 3000, text: 'Nothing to censor in this line' },
    { t: 5000, text: "I don't give a f***, sh*t" },
  ];
  const explicit = '[Verse 1]\nLook at all these niggas in here\nNothing to censor in this line\nI don\'t give a fuck, shit';
  const n = uncensor(lines, explicit);
  assert.equal(n, 3);
  assert.equal(lines[0].text, 'Look at all these niggas in here');
  assert.equal(lines[2].text, "I don't give a fuck, shit");
  assert.equal(lines[0].t, 1000);
});
