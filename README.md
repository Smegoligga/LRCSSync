# LRCSSync

Sync .lrc easier, faster and better.

A lightweight lyrics timing editor for Windows, macOS, Linux and Android. Open a song, get the lyrics, line them up with the vocals and save a `.lrc` file.

[![Build](https://github.com/Smegoligga/LRCSSync/actions/workflows/build.yml/badge.svg)](https://github.com/Smegoligga/LRCSSync/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/Smegoligga/LRCSSync?include_prereleases&label=release)](https://github.com/Smegoligga/LRCSSync/releases)

## Features

- Waveform and frequency view of the song, with a draggable voice band you fit to the singer
- Shows where singing starts and stops, and snaps lines to vocal starts
- Drag lines on the timeline, press and hold to zoom in for fine placement
- Tap-sync: play the song and tap as each line starts
- Nudge by 10, 50 or 100 ms, move every following line at once, loop a line, play from 0.1x to 4x speed
- Lyrics from [LRCLIB](https://lrclib.net), a `.lrc` or `.txt` file, or pasted text
- Splits lyrics into verses and choruses. Time one chorus and copy its timing to the others, found in the audio
- Marks instrumental parts and can add breaks so the last line doesn't hang around
- Edit, insert and delete lines, with undo and redo
- Save as `.lrc` or embed the lyrics into the song (MP3, FLAC, Ogg, Opus, M4A, WAV)
- Picks up a `.lrc` next to the song, or lyrics already embedded in it

## Download

Get the latest build from [Releases](https://github.com/Smegoligga/LRCSSync/releases):

| Platform | File |
|---|---|
| Windows | `x64-setup.exe` (installer) or `x64-portable.exe` |
| macOS | `universal.dmg` |
| Linux | `.AppImage` or `.deb` |
| Android | `android.apk` |

The builds aren't signed by Apple or Microsoft, so you may get a warning the first time. On macOS, if it says the app is damaged, run `xattr -cr /Applications/LRCSSync.app` once.

## How to use

1. **Open song** and pick an audio file (or drop it on the window).
2. **Lyrics** to search LRCLIB, paste lyrics or open a file. Synced results come in already timed. Plain lyrics you time yourself.
3. Drag the green edges in the frequency view so the band covers the voice. The green lane below it shows where singing is.
4. Play the song and press **Tap** (or Enter) as each line starts. Fix lines by dragging them, or with the nudge buttons.
5. **Save .lrc**, or **Embed** to write the lyrics into the song itself.

If a chorus repeats, time the first one, then press **Copy timing** on its header in the list.

Press and hold anywhere on the timeline to zoom in while you hold. Keyboard shortcuts are under the menu in the top right.

## Building from source

You need [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system.

```bash
npm install
npx tauri dev        # run
npx tauri build      # desktop installer
```

For Android, also install the Android SDK and NDK, then:

```bash
npx tauri android init
npx tauri android build --apk
```

Every push to `main` builds all platforms with GitHub Actions and publishes them in one pre-release named after the version in `src-tauri/tauri.conf.json`. Release notes come from `release-notes/<version>.md`.

Tests: `npm test` (editor logic) and `cargo test --manifest-path core/Cargo.toml` (audio analysis).

## Credits

- Lyrics search by [LRCLIB](https://lrclib.net)
- Built with [Tauri](https://tauri.app)

Licensed under [GPL-2.0](LICENSE).
