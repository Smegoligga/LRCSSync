import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceAll, countMatches } from '../ui/js/replace.js';

const doc = () => [{ text: 'Im walkin down the street' }, { text: 'Walkin, walkin all night' }, { text: 'Sidewalkin is not a word' }, { text: '' }];

test('replaces whole words everywhere and keeps the case', () => {
  const L = doc();
  assert.equal(countMatches(L, 'walkin'), 3);
  const r = replaceAll(L, 'walkin', 'walking');
  assert.deepEqual(r, { count: 3, lines: 2 });
  assert.equal(L[0].text, 'Im walking down the street');
  assert.equal(L[1].text, 'Walking, walking all night');
  assert.equal(L[2].text, 'Sidewalkin is not a word');
});

test('match case and part-of-word options', () => {
  const L = doc();
  assert.equal(replaceAll(L, 'Walkin', 'Strollin', { matchCase: true }).count, 1);
  assert.equal(L[0].text, 'Im walkin down the street');
  assert.equal(replaceAll(L, 'walkin', 'X', { wholeWord: false }).count, 3);
  assert.equal(L[2].text, 'SideX is not a word');
});

test('apostrophes, special characters and deleting a word', () => {
  const L = [{ text: "Im here, I'm there (yeah)" }];
  replaceAll(L, 'Im', "I'm");
  assert.equal(L[0].text, "I'm here, I'm there (yeah)");
  replaceAll(L, '(yeah)', '', { wholeWord: false });
  assert.equal(L[0].text, "I'm here, I'm there");
  assert.equal(replaceAll(L, '   ', 'x').count, 0);
});
