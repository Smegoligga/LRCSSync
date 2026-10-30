//! Audio analysis shared by the desktop and mobile apps.

pub mod spectrogram;
pub mod tags;

pub use spectrogram::{analyze, Spectrogram};
