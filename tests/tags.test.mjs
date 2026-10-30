import test from 'node:test';
import assert from 'node:assert/strict';
import { readTags, fromFileName } from '../ui/js/tags.js';

function id3(frames) {
  const parts = [];
  for (const [id, text] of frames) {
    const body = new Uint8Array([3, ...new TextEncoder().encode(text)]);
    const h = new Uint8Array(10);
    h.set([...id].map(c => c.charCodeAt(0)), 0);
    h[7] = body.length;
    parts.push(h, body);
  }
  const size = parts.reduce((n, p) => n + p.length, 0);
  const head = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, size]);
  const out = new Uint8Array(10 + size);
  out.set(head); let p = 10;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

test('ID3v2.4 title/artist/album', () => {
  const t = readTags(id3([['TIT2', 'Ultralight Beam'], ['TPE1', 'Kanye West'], ['TALB', 'The Life of Pablo']]), 'x.mp3');
  assert.deepEqual(t, { title: 'Ultralight Beam', artist: 'Kanye West', album: 'The Life of Pablo' });
});

test('FLAC vorbis comments', () => {
  const enc = s => new TextEncoder().encode(s);
  const le = n => [n & 255, n >> 8 & 255, n >> 16 & 255, n >> 24 & 255];
  const comments = ['TITLE=30 Hours', 'ARTIST=Kanye West'].map(enc);
  const body = [...le(3), ...enc('abc'), ...le(comments.length)];
  for (const c of comments) body.push(...le(c.length), ...c);
  const b = new Uint8Array([...enc('fLaC'), 0x84, 0, body.length >> 8, body.length & 255, ...body]);
  assert.deepEqual(readTags(b, 'f.flac'), { title: '30 Hours', artist: 'Kanye West', album: '' });
});

test('file name fallback', () => {
  assert.deepEqual(fromFileName('C:\\Music\\03. Kanye West - Famous.flac'), { artist: 'Kanye West', title: 'Famous' });
  assert.deepEqual(fromFileName('content://media/primary%3AMusic%2FFML.mp3'), { title: 'FML' });
  assert.deepEqual(readTags(new Uint8Array(4), 'Artist - Song.mp3'), { title: 'Song', artist: 'Artist', album: '' });
});
