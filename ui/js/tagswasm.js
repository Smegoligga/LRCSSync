// Tags in the web version: the apps' own Rust tag code (lrcs-core, built from web-tags/ to WebAssembly) runs in
// the page, so embedding works the same as in the apps. The build puts the module in window.LRCSSYNC_TAGS_WASM.

let ready = null;

/** Starts the module from bytes (tests) or from the copy built into the page. */
export function loadTagsWasm(bytes) {
  ready = (async () => {
    const mod = await WebAssembly.compile(bytes);
    // the module isn't expected to need anything, but give every import a harmless stub just in case
    const imports = {};
    for (const imp of WebAssembly.Module.imports(mod)) {
      (imports[imp.module] ||= {})[imp.name] = imp.kind === 'function' ? () => 0 : undefined;
    }
    return (await WebAssembly.instantiate(mod, imports)).exports;
  })();
  return ready;
}

export const tagsWasmAvailable = () => !!ready || (typeof window !== 'undefined' && !!window.LRCSSYNC_TAGS_WASM);

function exportsReady() {
  if (ready) return ready;
  const b64 = typeof window !== 'undefined' && window.LRCSSYNC_TAGS_WASM;
  if (!b64) return Promise.reject(new Error('Embedding needs the app'));
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return loadTagsWasm(bytes);
}

function put(x, bytes) {
  const p = x.alloc(bytes.length);
  new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
  return p;
}

function takeOut(x) {
  const out = new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()).slice();
  x.out_clear();
  return out;
}

/** Audio bytes with `lyrics` written into the tags. Throws with the reason when the file can't hold them. */
export async function wasmEmbed(audioBytes, lyrics) {
  const x = await exportsReady();
  const text = new TextEncoder().encode(lyrics);
  const a = put(x, audioBytes), l = put(x, text);
  try {
    const code = x.embed(a, audioBytes.length, l, text.length);
    const out = takeOut(x);
    if (code !== 0) throw new Error(new TextDecoder().decode(out) || 'Couldn\'t write the tags');
    return out;
  } finally {
    x.dealloc(a, audioBytes.length);
    x.dealloc(l, text.length);
  }
}

/** Lyrics embedded in the audio's tags, or null. */
export async function wasmRead(audioBytes) {
  const x = await exportsReady();
  const a = put(x, audioBytes);
  try {
    const code = x.read(a, audioBytes.length);
    const out = takeOut(x);
    return code === 0 ? new TextDecoder().decode(out) : null;
  } finally {
    x.dealloc(a, audioBytes.length);
  }
}
