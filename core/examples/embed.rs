// cargo run --example embed -- in.mp3 lyrics.lrc out.mp3
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let audio = std::fs::read(&a[1]).unwrap();
    let lrc = std::fs::read_to_string(&a[2]).unwrap();
    std::fs::write(&a[3], lrcs_core::tags::embed_lyrics(&audio, &lrc).unwrap()).unwrap();
}
