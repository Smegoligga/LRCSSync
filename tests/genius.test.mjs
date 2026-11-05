import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeniusHtml, isBotCheck } from '../ui/js/genius.js';
import { parse } from '../ui/js/lrc.js';
import { matchRatio, phrases } from '../ui/js/identify.js';

const PAGE = `<html><body><div class="x">
<div data-lyrics-container="true" class="Lyrics__Container">
  <div data-exclude-from-selection="true" class="LyricsHeader"><div>42 Contributors</div><div>Translations</div><h2>Ultralight Beam Lyrics</h2></div>
  [Intro: Natalie Green]<br/>We on an ultralight beam<br>We on an ultralight beam<br/><br/>[Chorus: Kanye West &amp; The-Dream]<br/>I&#x27;m tryna keep my faith<br/><a href="/x"><span>But I&#39;m lookin&#x27; for more</span></a><br/>
</div>
<div data-lyrics-container="true">[Verse 1: Kelly Price]<br/>Somewhere I heard<br/></div>
</div></body></html>`;

test('Genius page parsing drops headers and decodes text', () => {
  const t = parseGeniusHtml(PAGE);
  assert.ok(!/Contributors|Translations|Ultralight Beam Lyrics/.test(t), t);
  assert.ok(t.includes("I'm tryna keep my faith"));
  assert.ok(t.includes("But I'm lookin' for more"));
  assert.ok(t.includes('[Verse 1: Kelly Price]'));
  assert.equal(parseGeniusHtml('<html>Just a moment...</html>'), null);
  assert.ok(isBotCheck(403, ''));
  assert.ok(isBotCheck(200, '<div id="challenge-platform">'));
});

test('Genius headers and junk are not lyrics', () => {
  const d = parse('42 Contributors\nUltralight Beam Lyrics\n[Intro: Natalie Green]\nWe on an ultralight beam\n\n[Chorus: Kanye West & The-Dream]\nI\'m tryna keep my faith\n[Kanye West]\nLook for more\nYou might also like\n12Embed');
  assert.deepEqual(d.lines.map(l => l.text), ['We on an ultralight beam', "I'm tryna keep my faith", 'Look for more']);
  assert.equal(d.lines[0].label, 'Intro');
  assert.equal(d.lines[1].label, 'Chorus');
  assert.equal(d.lines[2].sec, true);
  // in LRC too
  const s = parse('[00:01.00][Chorus]\n[00:02.00]real line\n[00:03.00][Kid Cudi]\n');
  assert.deepEqual(s.lines.map(l => l.text), ['real line']);
});

test('song identification only when sure', () => {
  const lyrics = 'Hello darkness my old friend\nI have come to talk with you again\nBecause a vision softly creeping\nLeft its seeds while I was sleeping\nAnd the vision that was planted in my brain\nStill remains within the sound of silence';
  const heard = 'hello darkness my old friend I come to talk with you again because the vision softly creeping left its seats while I was sleeping'.split(' ').map((text, i) => ({ text, start: i * 300, end: i * 300 + 250 }));
  const yes = matchRatio(lyrics, heard);
  assert.ok(yes.ratio >= 0.8, JSON.stringify(yes));
  const other = 'I want to hold your hand\nOh please say to me you will let me be your man\nAnd please say to me you will let me hold your hand';
  const no = matchRatio(other, heard);
  assert.ok(no.ratio < 0.3, JSON.stringify(no));
  assert.equal(phrases(heard).length, 2);
});
