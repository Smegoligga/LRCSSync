//! Reading and writing lyrics embedded in audio files (MP3, FLAC, Ogg, Opus, M4A, WAV, AIFF, APE...).

use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::{AudioFile, FileType, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag, TagSupport, TagType};
use std::io::Cursor;

fn target_type(file_type: FileType, primary: TagType) -> TagType {
    match file_type {
        // ID3v2 is what players read for these (WAV/AIFF's own tag formats have no lyrics field)
        FileType::Mpeg | FileType::Wav | FileType::Aiff => TagType::Id3v2,
        _ => primary,
    }
}

fn lyrics_key(tag_type: TagType) -> ItemKey {
    // ID3v2 only accepts lyrics as USLT (UnsyncLyrics); it holds LRC text fine and is what players read
    if tag_type == TagType::Id3v2 { ItemKey::UnsyncLyrics } else { ItemKey::Lyrics }
}

/// Returns `audio` with `lyrics` written into its tags. Other tags are kept.
pub fn embed_lyrics(audio: &[u8], lyrics: &str) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(audio.to_vec());
    let mut tagged = Probe::new(&mut cursor)
        .options(ParseOptions::new())
        .guess_file_type()
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| format!("Can't read this file's tags: {e}"))?;
    let tt = target_type(tagged.file_type(), tagged.primary_tag_type());
    if !matches!(tagged.file_type().tag_support(tt), TagSupport::ReadWrite) {
        return Err("This file type can't hold lyrics".into());
    }
    if tagged.tag(tt).is_none() {
        tagged.insert_tag(Tag::new(tt));
    }
    let tag = tagged.tag_mut(tt).unwrap();
    tag.remove_key(ItemKey::Lyrics);
    tag.remove_key(ItemKey::UnsyncLyrics);
    let lyrics = lyrics.trim_end().replace("\r\n", "\n");
    if !tag.insert_text(lyrics_key(tt), lyrics) {
        return Err("Couldn't add lyrics to this file's tags".into());
    }
    let mut out = Cursor::new(audio.to_vec());
    tagged
        .save_to(&mut out, WriteOptions::default())
        .map_err(|e| format!("Couldn't write the tags: {e}"))?;
    Ok(out.into_inner())
}

/// Lyrics found in any of the file's tags.
pub fn read_lyrics(audio: &[u8]) -> Option<String> {
    let mut cursor = Cursor::new(audio);
    let tagged = Probe::new(&mut cursor).guess_file_type().ok()?.read().ok()?;
    for tag in tagged.tags() {
        for key in [ItemKey::Lyrics, ItemKey::UnsyncLyrics] {
            if let Some(v) = tag.get_string(key) {
                if !v.trim().is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// Frames the request body used by the app: u32 LE lyrics length, lyrics (UTF-8), audio bytes.
pub fn split_request(body: &[u8]) -> Result<(String, &[u8]), String> {
    if body.len() < 4 {
        return Err("bad request".into());
    }
    let n = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if body.len() < 4 + n {
        return Err("bad request".into());
    }
    let text = String::from_utf8(body[4..4 + n].to_vec()).map_err(|_| "lyrics are not UTF-8".to_string())?;
    Ok((text, &body[4 + n..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LRC: &str = "[ti:Tone]\n[00:00.10]First line\n[00:00.50]Second line\n";

    fn check(name: &str) {
        let path = format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"));
        let audio = std::fs::read(&path).unwrap();
        assert_eq!(read_lyrics(&audio), None, "{name} starts without lyrics");
        let out = embed_lyrics(&audio, LRC).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(read_lyrics(&out).as_deref(), Some(LRC.trim_end()), "{name}");
        // replacing keeps one copy
        let again = embed_lyrics(&out, "[00:01.00]New").unwrap();
        assert_eq!(read_lyrics(&again).as_deref(), Some("[00:01.00]New"), "{name}");
        // other tags survive
        let mut c = Cursor::new(&again[..]);
        let t = Probe::new(&mut c).guess_file_type().unwrap().read().unwrap();
        let title = t.tags().iter().find_map(|tag| tag.get_string(ItemKey::TrackTitle).map(str::to_string));
        assert_eq!(title.as_deref(), Some("Tone"), "{name} kept its title");
        // audio length roughly unchanged
        assert!(again.len() + 64 >= audio.len(), "{name} shrank");
    }

    #[test] fn mp3() { check("t.mp3"); }
    #[test] fn flac() { check("t.flac"); }
    #[test] fn ogg() { check("t.ogg"); }
    #[test] fn opus() { check("t.opus"); }
    #[test] fn m4a() { check("t.m4a"); }
    #[test] fn wav() { check("t.wav"); }

    #[test]
    fn rejects_garbage() {
        assert!(embed_lyrics(b"not audio at all", LRC).is_err());
        assert_eq!(read_lyrics(b"nope"), None);
    }

    #[test]
    fn request_framing() {
        let mut b = (3u32).to_le_bytes().to_vec();
        b.extend_from_slice(b"abcXYZ");
        let (t, a) = split_request(&b).unwrap();
        assert_eq!(t, "abc");
        assert_eq!(a, b"XYZ");
        assert!(split_request(&[1, 0]).is_err());
    }
}
