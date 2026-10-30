// Reads title / artist / album from common audio tags, falling back to the file name.

function decodeText(bytes, enc) {
  try {
    if (enc === 1 || enc === 2) {
      let le = enc === 1, start = 0;
      if (enc === 1 && bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) { le = true; start = 2; }
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) { le = false; start = 2; }
      }
      return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(start));
    }
    return new TextDecoder(enc === 3 ? 'utf-8' : 'latin1').decode(bytes);
  } catch { return ''; }
}

const clean = s => (s || '').replace(/\0+$/g, '').split('\0')[0].trim();

function id3v2(b) {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const ver = b[3];
  const size = (b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f);
  const end = Math.min(b.length, 10 + size);
  const out = {};
  let p = 10;
  if (b[5] & 0x40) { // extended header
    const ext = ver === 4 ? ((b[p] & 0x7f) << 21 | (b[p + 1] & 0x7f) << 14 | (b[p + 2] & 0x7f) << 7 | (b[p + 3] & 0x7f)) : ((b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) + 4);
    p += ext;
  }
  const want = ver === 2 ? { TT2: 'title', TP1: 'artist', TAL: 'album' } : { TIT2: 'title', TPE1: 'artist', TALB: 'album' };
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  while (p + hdr <= end) {
    const id = String.fromCharCode(...b.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let len;
    if (ver === 2) len = b[p + 3] << 16 | b[p + 4] << 8 | b[p + 5];
    else if (ver === 4) len = (b[p + 4] & 0x7f) << 21 | (b[p + 5] & 0x7f) << 14 | (b[p + 6] & 0x7f) << 7 | (b[p + 7] & 0x7f);
    else len = (b[p + 4] << 24 | b[p + 5] << 16 | b[p + 6] << 8 | b[p + 7]) >>> 0;
    const body = b.subarray(p + hdr, Math.min(end, p + hdr + len));
    if (want[id] && body.length > 1) out[want[id]] = clean(decodeText(body.subarray(1), body[0]));
    p += hdr + len;
  }
  return out;
}

function vorbisComments(b, p) {
  const u32 = i => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
  const out = {};
  if (p + 4 > b.length) return out;
  const vendor = u32(p); p += 4 + vendor;
  if (p + 4 > b.length) return out;
  const n = u32(p); p += 4;
  const map = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album' };
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const len = u32(p); p += 4;
    if (p + len > b.length) break;
    const s = new TextDecoder('utf-8').decode(b.subarray(p, p + len));
    p += len;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = map[s.slice(0, eq).toUpperCase()];
    if (k && !out[k]) out[k] = s.slice(eq + 1).trim();
  }
  return out;
}

function flac(b) {
  if (b.length < 8 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'fLaC') return null;
  let p = 4;
  while (p + 4 <= b.length) {
    const last = b[p] & 0x80, type = b[p] & 0x7f, len = b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3];
    if (type === 4) return vorbisComments(b, p + 4);
    p += 4 + len;
    if (last) break;
  }
  return {};
}

function ogg(b) {
  if (b.length < 4 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'OggS') return null;
  const limit = Math.min(b.length, 1 << 16);
  const find = sig => {
    outer: for (let i = 0; i + sig.length < limit; i++) {
      for (let j = 0; j < sig.length; j++) if (b[i + j] !== sig[j]) continue outer;
      return i + sig.length;
    }
    return -1;
  };
  let p = find([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]); // \x03vorbis
  if (p < 0) p = find([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // OpusTags
  return p < 0 ? {} : vorbisComments(b, p);
}

/** Splits "01. Artist - Title.mp3" style names. */
export function fromFileName(name) {
  let base = decodeURIComponent(String(name || '')).split(/[\\/:]/).pop().replace(/\.[a-z0-9]{2,5}$/i, '');
  base = base.replace(/^\s*\d{1,3}\s*[-._)]?\s+/, '').trim();
  const i = base.indexOf(' - ');
  if (i > 0) return { artist: base.slice(0, i).trim(), title: base.slice(i + 3).trim() };
  return { title: base };
}

export function readTags(bytes, fileName) {
  let t = null;
  try { t = id3v2(bytes) || flac(bytes) || ogg(bytes); } catch { t = null; }
  const f = fromFileName(fileName);
  return {
    title: (t && t.title) || f.title || '',
    artist: (t && t.artist) || f.artist || '',
    album: (t && t.album) || '',
  };
}
