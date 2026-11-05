use std::borrow::Cow;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

/// The binary body of a command. Desktop gets it raw; Android's webview bridge can't carry
/// raw bytes, so there it arrives as JSON - an array of numbers or {"0": n, "1": n, ...}.
fn body_bytes<'a>(request: &'a Request<'_>, what: &str) -> Result<Cow<'a, [u8]>, String> {
    match request.body() {
        InvokeBody::Raw(b) => Ok(Cow::Borrowed(b.as_slice())),
        InvokeBody::Json(v) => json_bytes(v).map(Cow::Owned).ok_or_else(|| format!("expected {what}")),
        #[allow(unreachable_patterns)]
        _ => Err(format!("expected {what}")),
    }
}

fn json_bytes(v: &serde_json::Value) -> Option<Vec<u8>> {
    use serde_json::Value;
    let byte = |x: &Value| x.as_u64().filter(|n| *n < 256).map(|n| n as u8);
    match v {
        Value::Array(a) => a.iter().map(byte).collect(),
        Value::Object(m) => {
            let mut out = vec![0u8; m.len()];
            for (k, x) in m {
                let i: usize = k.parse().ok()?;
                *out.get_mut(i)? = byte(x)?;
            }
            Some(out)
        }
        _ => None,
    }
}

/// Takes raw little-endian f32 mono samples at 16 kHz (the UI decodes the audio) and
/// returns the spectrogram in the binary layout from `lrcs_core::Spectrogram::to_bytes`.
#[tauri::command]
async fn analyze(request: Request<'_>) -> Result<Response, String> {
    let bytes = body_bytes(&request, "raw audio samples")?;
    let sample_rate = request
        .headers()
        .get("sample-rate")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(16000);
    let samples = lrcs_core::spectrogram::samples_from_bytes(&bytes);
    let spec = lrcs_core::analyze(&samples, sample_rate);
    Ok(Response::new(spec.to_bytes()))
}

/// Body: u32 LE lyrics length, lyrics, audio bytes. Returns the audio with the lyrics in its tags.
#[tauri::command]
async fn embed_lyrics(request: Request<'_>) -> Result<Response, String> {
    let body = body_bytes(&request, "raw data")?;
    let (lyrics, audio) = lrcs_core::tags::split_request(&body)?;
    Ok(Response::new(lrcs_core::tags::embed_lyrics(audio, &lyrics)?))
}

/// Body: audio bytes. Returns the lyrics embedded in its tags, if any.
#[tauri::command]
async fn read_lyrics(request: Request<'_>) -> Result<Option<String>, String> {
    let body = body_bytes(&request, "raw data")?;
    Ok(lrcs_core::tags::read_lyrics(&body))
}

/// Opens a Genius page in its own window (desktop) so you can pass Genius's bot check.
/// The page script sends the lyrics back with `genius_lyrics`.
#[tauri::command]
async fn open_genius(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let u: tauri::Url = url.parse().map_err(|_| "bad address".to_string())?;
    let host = u.host_str().unwrap_or("");
    if u.scheme() != "https" || !(host == "genius.com" || host.ends_with(".genius.com")) {
        return Err("only genius.com pages".into());
    }
    #[cfg(desktop)]
    {
        if let Some(w) = app.get_webview_window("genius") {
            let _ = w.close();
        }
        tauri::WebviewWindowBuilder::new(&app, "genius", tauri::WebviewUrl::External(u))
            .title("Genius - pass the check, the lyrics come back by themselves")
            .inner_size(960.0, 820.0)
            .initialization_script(include_str!("genius_window.js"))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("no second windows on phones".into())
    }
}

/// Called from the Genius window with the lyrics it found.
#[tauri::command]
fn genius_lyrics(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.emit_to("main", "genius-lyrics", text).map_err(|e| e.to_string())?;
    if let Some(w) = app.get_webview_window("genius") {
        let _ = w.close();
    }
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.set_focus();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![analyze, embed_lyrics, read_lyrics, open_genius, genius_lyrics])
        .run(tauri::generate_context!())
        .expect("error while running LRCSSync");
}
