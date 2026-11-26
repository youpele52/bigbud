//! `MemorySampler`: one memory sample every 10 s using std plus libc only (plan §8.6).

#[cfg(any(target_os = "linux", test))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(any(target_os = "linux", test))]
pub use linux::LinuxMemorySource;
#[cfg(target_os = "macos")]
pub use macos::MacosMemorySource;

use super::pressure::{MemorySample, PressureLevel};

/// Debug builds only: forces every sample to this level (`normal`, `low` or `critical`).
pub const PRESSURE_OVERRIDE_ENV: &str = "BIGBUD_DEBUG_TERMINAL_PRESSURE";

#[derive(Debug, Clone, Default)]
pub struct MemorySampler {
    #[cfg(target_os = "linux")]
    source: LinuxMemorySource,
    #[cfg(target_os = "macos")]
    source: MacosMemorySource,
    #[cfg(debug_assertions)]
    forced: Option<PressureLevel>,
}

impl MemorySampler {
    pub fn new() -> Self {
        #[cfg_attr(not(debug_assertions), allow(unused_mut))]
        let mut sampler = Self::default();
        #[cfg(debug_assertions)]
        {
            sampler.forced = std::env::var(PRESSURE_OVERRIDE_ENV)
                .ok()
                .as_deref()
                .and_then(parse_level);
        }
        sampler
    }

    /// Debug-only pressure override for tests; release builds have no such switch.
    #[cfg(debug_assertions)]
    pub fn set_pressure_override(&mut self, level: Option<PressureLevel>) {
        self.forced = level;
    }

    /// Samples the platform signals. `terminal_rss` is the latest tree-RSS sum of the managed
    /// PTYs, which the host refreshes every 30 s. Drop cached snapshots and shrink buffers
    /// before sampling so host RSS reflects what cannot be relieved.
    pub fn sample(&self, terminal_rss: Option<u64>) -> MemorySample {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let mut sample = self.source.sample();
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let mut sample = MemorySample::default();
        sample.terminal_rss_bytes = terminal_rss;
        #[cfg(debug_assertions)]
        {
            sample.forced = self.forced;
        }
        sample
    }
}

pub fn parse_level(value: &str) -> Option<PressureLevel> {
    match value.trim().to_ascii_lowercase().as_str() {
        "normal" => Some(PressureLevel::Normal),
        "low" => Some(PressureLevel::Low),
        "critical" => Some(PressureLevel::Critical),
        _ => None,
    }
}

#[cfg(test)]
#[path = "linux.tests.rs"]
mod linux_tests;
#[cfg(test)]
#[path = "sampler.tests.rs"]
mod sampler_tests;
