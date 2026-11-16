//! The same tag code the apps use (lrcs_core::tags), for the web version.
//! Plain WebAssembly exports, no bindings generator: the page copies bytes in with `alloc`, calls
//! `embed`/`read`, then reads the answer from `out_ptr`/`out_len`.
//!
//!   embed(audio, audio_len, lyrics, lyrics_len) -> 0 ok (out = new file), 1 error (out = message)
//!   read(audio, audio_len)                      -> 0 found (out = lyrics), 1 none

use std::cell::RefCell;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_out(v: Vec<u8>) {
    OUT.with(|o| *o.borrow_mut() = v);
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`cap` must come from `alloc(cap)`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, cap: usize) {
    drop(Vec::from_raw_parts(ptr, 0, cap.max(1)));
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

/// Frees the last answer (it can be the size of a whole song).
#[no_mangle]
pub extern "C" fn out_clear() {
    set_out(Vec::new());
}

/// # Safety
/// The pointers must point to `audio_len` / `lyrics_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn embed(audio: *const u8, audio_len: usize, lyrics: *const u8, lyrics_len: usize) -> i32 {
    let audio = std::slice::from_raw_parts(audio, audio_len);
    let lyrics = match std::str::from_utf8(std::slice::from_raw_parts(lyrics, lyrics_len)) {
        Ok(s) => s,
        Err(_) => {
            set_out(b"lyrics are not UTF-8".to_vec());
            return 1;
        }
    };
    match lrcs_core::tags::embed_lyrics(audio, lyrics) {
        Ok(v) => {
            set_out(v);
            0
        }
        Err(e) => {
            set_out(e.into_bytes());
            1
        }
    }
}

/// # Safety
/// The pointer must point to `audio_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn read(audio: *const u8, audio_len: usize) -> i32 {
    let audio = std::slice::from_raw_parts(audio, audio_len);
    match lrcs_core::tags::read_lyrics(audio) {
        Some(s) => {
            set_out(s.into_bytes());
            0
        }
        None => {
            set_out(Vec::new());
            1
        }
    }
}
