use tauri::ipc::{InvokeBody, Request, Response};

/// Takes raw little-endian f32 mono samples at 16 kHz (the UI decodes the audio) and
/// returns the spectrogram in the binary layout from `lrcs_core::Spectrogram::to_bytes`.
#[tauri::command]
async fn analyze(request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw audio samples".into());
    };
    let sample_rate = request
        .headers()
        .get("sample-rate")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(16000);
    let samples = lrcs_core::spectrogram::samples_from_bytes(bytes);
    let spec = lrcs_core::analyze(&samples, sample_rate);
    Ok(Response::new(spec.to_bytes()))
}

/// Body: u32 LE lyrics length, lyrics, audio bytes. Returns the audio with the lyrics in its tags.
#[tauri::command]
async fn embed_lyrics(request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("expected raw data".into());
    };
    let (lyrics, audio) = lrcs_core::tags::split_request(body)?;
    Ok(Response::new(lrcs_core::tags::embed_lyrics(audio, &lyrics)?))
}

/// Body: audio bytes. Returns the lyrics embedded in its tags, if any.
#[tauri::command]
async fn read_lyrics(request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("expected raw data".into());
    };
    Ok(lrcs_core::tags::read_lyrics(body))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![analyze, embed_lyrics, read_lyrics])
        .run(tauri::generate_context!())
        .expect("error while running LRCSSync");
}
