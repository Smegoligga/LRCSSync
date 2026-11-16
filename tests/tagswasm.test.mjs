// The web version's tag module (web-tags/ built to WebAssembly) embeds and reads lyrics like the apps.
// Skipped when the module hasn't been built (cargo build --release --target wasm32-unknown-unknown
// --manifest-path web-tags/Cargo.toml); CI always builds it first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadTagsWasm, wasmEmbed, wasmRead } from '../ui/js/tagswasm.js';

const WASM = 'web-tags/target/wasm32-unknown-unknown/release/lrcs_web_tags.wasm';
const have = existsSync(WASM);
const LRC = '[ti:Tone]\n[00:00.10]First line\n[00:00.50]Second line ünïcödé\n';

test('web tag module embeds and reads back lyrics in every test file', { skip: !have && 'module not built' }, async () => {
  await loadTagsWasm(readFileSync(WASM));
  for (const name of ['t.mp3', 't.flac', 't.ogg', 't.opus', 't.m4a', 't.wav']) {
    const audio = new Uint8Array(readFileSync('core/testdata/' + name));
    assert.equal(await wasmRead(audio), null, name + ' starts without lyrics');
    const out = await wasmEmbed(audio, LRC);
    assert.equal(await wasmRead(out), LRC.trimEnd(), name);
    const again = await wasmEmbed(out, '[00:01.00]New');
    assert.equal(await wasmRead(again), '[00:01.00]New', name + ' replaced, one copy');
    assert.ok(again.length + 64 >= audio.length, name + ' kept its audio');
  }
});

test('web tag module refuses files that are not audio', { skip: !have && 'module not built' }, async () => {
  await loadTagsWasm(readFileSync(WASM));
  await assert.rejects(wasmEmbed(new TextEncoder().encode('not audio at all'), LRC));
  assert.equal(await wasmRead(new Uint8Array([1, 2, 3])), null);
});
