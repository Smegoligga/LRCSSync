fn main() {
    // App commands need permissions so the Genius window can be allowed just one of them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["analyze", "embed_lyrics", "read_lyrics", "open_genius", "genius_lyrics"]),
    ))
    .expect("failed to run tauri-build");
}
