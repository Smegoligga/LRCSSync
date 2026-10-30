//! Log-frequency spectrogram used for the frequency view, the voice band and vocal start detection.

use rustfft::{num_complex::Complex32, FftPlanner};

/// Frames per second of the analysis (one frame every 10 ms).
pub const FRAMES_PER_SECOND: u32 = 100;
/// Number of log-spaced frequency rows.
pub const BINS: usize = 128;
/// Lowest frequency shown.
pub const F_MIN: f32 = 50.0;
/// Highest frequency shown (capped at half the sample rate).
pub const F_MAX: f32 = 8000.0;
/// Range of the stored dB values: the loudest cell maps to 255, this many dB below to 0.
pub const DB_RANGE: f32 = 90.0;

pub struct Spectrogram {
    pub frames: usize,
    pub bins: usize,
    pub f_min: f32,
    pub f_max: f32,
    pub hop_seconds: f32,
    /// Loudest value in dB (maps to 255).
    pub db_max: f32,
    pub db_range: f32,
    /// frames * bins values, frame-major.
    pub data: Vec<u8>,
}

impl Spectrogram {
    pub fn cell(&self, frame: usize, bin: usize) -> u8 {
        self.data[frame * self.bins + bin]
    }

    /// Centre frequency of a row.
    pub fn bin_hz(&self, bin: usize) -> f32 {
        let r = (self.f_max / self.f_min).ln();
        self.f_min * ((bin as f32 + 0.5) / self.bins as f32 * r).exp()
    }

    /// Binary layout read by the UI:
    /// "LRS1", u32 frames, u32 bins, f32 f_min, f32 f_max, f32 hop_seconds, f32 db_max, f32 db_range, u8 data.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(32 + self.data.len());
        out.extend_from_slice(b"LRS1");
        out.extend_from_slice(&(self.frames as u32).to_le_bytes());
        out.extend_from_slice(&(self.bins as u32).to_le_bytes());
        for v in [self.f_min, self.f_max, self.hop_seconds, self.db_max, self.db_range] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&self.data);
        out
    }
}

/// Analyses mono samples at `sample_rate`.
pub fn analyze(samples: &[f32], sample_rate: u32) -> Spectrogram {
    let sr = sample_rate.max(1000) as f32;
    let hop = (sample_rate / FRAMES_PER_SECOND).max(1) as usize;
    // ~64 ms window, rounded to a power of two
    let win = ((sr * 0.064) as usize).next_power_of_two().max(256);
    let f_max = F_MAX.min(sr / 2.0);
    let frames = if samples.is_empty() { 0 } else { (samples.len() + hop - 1) / hop };

    let window: Vec<f32> = (0..win)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / win as f32).cos())
        .collect();
    let win_norm: f32 = window.iter().map(|w| w * w).sum();

    // Map FFT bins onto log rows
    let fft_bins = win / 2 + 1;
    let bin_hz = sr / win as f32;
    let ratio = (f_max / F_MIN).ln();
    let edge = |k: usize| F_MIN * (k as f32 / BINS as f32 * ratio).exp();
    let mut rows: Vec<(usize, usize, f32)> = Vec::with_capacity(BINS); // (first fft bin, last+1, interp position)
    for k in 0..BINS {
        let lo = edge(k);
        let hi = edge(k + 1);
        let a = (lo / bin_hz).ceil() as usize;
        let b = ((hi / bin_hz).ceil() as usize).min(fft_bins);
        let centre = (lo * hi).sqrt() / bin_hz;
        rows.push((a, b, centre));
    }

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(win);
    let mut buf = vec![Complex32::new(0.0, 0.0); win];
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut power = vec![0f32; fft_bins];
    let mut db = vec![0f32; frames * BINS];

    for f in 0..frames {
        let centre = f * hop;
        let start = centre as isize - (win / 2) as isize;
        for i in 0..win {
            let idx = start + i as isize;
            let s = if idx >= 0 && (idx as usize) < samples.len() { samples[idx as usize] } else { 0.0 };
            buf[i] = Complex32::new(s * window[i], 0.0);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        for (i, p) in power.iter_mut().enumerate() {
            *p = buf[i].norm_sqr() / win_norm;
        }
        for (k, &(a, b, c)) in rows.iter().enumerate() {
            let p = if b > a {
                power[a..b].iter().sum::<f32>() / (b - a) as f32
            } else {
                // Row narrower than an FFT bin (low frequencies): interpolate
                let i = (c.floor() as usize).min(fft_bins - 2);
                let t = (c - i as f32).clamp(0.0, 1.0);
                power[i] * (1.0 - t) + power[i + 1] * t
            };
            db[f * BINS + k] = 10.0 * (p + 1e-12).log10();
        }
    }

    let db_max = db.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let db_max = if db_max.is_finite() { db_max } else { 0.0 };
    let data = db
        .iter()
        .map(|&v| (((v - (db_max - DB_RANGE)) / DB_RANGE) * 255.0).round().clamp(0.0, 255.0) as u8)
        .collect();

    Spectrogram {
        frames,
        bins: BINS,
        f_min: F_MIN,
        f_max,
        hop_seconds: hop as f32 / sr,
        db_max,
        db_range: DB_RANGE,
        data,
    }
}

/// Reads little-endian f32 samples from raw bytes (as sent by the UI).
pub fn samples_from_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f32, secs: f32, sr: u32) -> Vec<f32> {
        (0..(secs * sr as f32) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / sr as f32).sin() * 0.5)
            .collect()
    }

    fn loudest_bin(s: &Spectrogram, frame: usize) -> usize {
        (0..s.bins).max_by_key(|&b| s.cell(frame, b)).unwrap()
    }

    #[test]
    fn frame_count_and_hop() {
        let s = analyze(&tone(440.0, 2.0, 16000), 16000);
        assert_eq!(s.frames, 200);
        assert!((s.hop_seconds - 0.01).abs() < 1e-6);
        assert_eq!(s.data.len(), 200 * BINS);
    }

    #[test]
    fn tone_lands_in_right_row() {
        for hz in [110.0, 440.0, 1000.0, 3000.0] {
            let s = analyze(&tone(hz, 1.0, 16000), 16000);
            let b = loudest_bin(&s, 50);
            let got = s.bin_hz(b);
            assert!((got / hz).ln().abs() < 0.08, "{hz} Hz -> row {b} at {got} Hz");
        }
    }

    #[test]
    fn silence_then_tone_onset() {
        let sr = 16000;
        let mut x = vec![0.0; sr as usize]; // 1 s silence
        x.extend(tone(800.0, 1.0, sr));
        let s = analyze(&x, sr);
        let row = loudest_bin(&s, 150);
        // Before the onset the row is near the floor, after it is loud
        assert!(s.cell(80, row) < 40, "before: {}", s.cell(80, row));
        assert!(s.cell(120, row) > 200, "after: {}", s.cell(120, row));
    }

    #[test]
    fn works_at_other_sample_rates() {
        let s = analyze(&tone(500.0, 1.0, 44100), 44100);
        assert_eq!(s.frames, 100);
        let b = loudest_bin(&s, 50);
        assert!((s.bin_hz(b) / 500.0).ln().abs() < 0.08);
        let s = analyze(&tone(500.0, 1.0, 8000), 8000);
        assert!(s.f_max <= 4000.0);
    }

    #[test]
    fn empty_input() {
        let s = analyze(&[], 16000);
        assert_eq!(s.frames, 0);
        assert_eq!(s.to_bytes().len(), 32);
    }

    #[test]
    fn bytes_round_trip() {
        let s = analyze(&tone(440.0, 0.5, 16000), 16000);
        let b = s.to_bytes();
        assert_eq!(&b[0..4], b"LRS1");
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize, s.frames);
        assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize, BINS);
        assert_eq!(b.len(), 32 + s.frames * BINS);
        let samples = samples_from_bytes(&1.5f32.to_le_bytes());
        assert_eq!(samples, vec![1.5]);
    }
}
