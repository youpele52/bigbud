//! Memory-pressure classification and the act/clear hysteresis and close rate limits (§8.6).

use std::collections::VecDeque;

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
pub const CLOSE_SPACING_MS: u64 = 30_000;
pub const CLOSE_WINDOW_MS: u64 = 5 * 60_000;
pub const NO_CANDIDATE_INTERVAL_MS: u64 = 10 * 60_000;
const SAMPLES_TO_ACT: usize = 2;
const SAMPLES_TO_CLEAR: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PressureLevel {
    Normal,
    Low,
    Critical,
}

/// One memory sample; any signal may be unavailable on a platform.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemorySample {
    /// Linux PSI `some avg10` (cgroup's when inside cgroup v2).
    pub psi_some_avg10: Option<f64>,
    /// macOS `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical).
    pub os_level: Option<u32>,
    pub available_bytes: Option<u64>,
    /// Effective total (cgroup-limited on Linux).
    pub total_bytes: Option<u64>,
    pub host_rss_bytes: Option<u64>,
    /// Sum of the managed PTYs' process trees, refreshed every 30 s.
    pub terminal_rss_bytes: Option<u64>,
    /// Debug-only pressure override; release builds never set it.
    pub forced: Option<PressureLevel>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryThresholds {
    pub psi_low: f64,
    pub psi_critical: f64,
    pub os_level_low: u32,
    pub os_level_critical: u32,
    pub available_low_percent: u64,
    pub available_low_floor: u64,
    pub available_critical_percent: u64,
    pub available_critical_floor: u64,
    pub host_rss_low: u64,
    pub host_rss_critical: u64,
    pub terminal_rss_low_percent: u64,
    pub terminal_rss_critical_percent: u64,
}

impl Default for MemoryThresholds {
    fn default() -> Self {
        Self {
            psi_low: 10.0,
            psi_critical: 30.0,
            os_level_low: 2,
            os_level_critical: 4,
            available_low_percent: 8,
            available_low_floor: GIB,
            available_critical_percent: 4,
            available_critical_floor: 512 * MIB,
            host_rss_low: 512 * MIB,
            host_rss_critical: 768 * MIB,
            terminal_rss_low_percent: 50,
            terminal_rss_critical_percent: 70,
        }
    }
}

impl MemoryThresholds {
    /// Keeps every Critical threshold at least as strict as its Low one.
    pub fn clamped(mut self) -> Self {
        let finite = |value: f64, fallback: f64| {
            if value.is_finite() {
                value.max(0.0)
            } else {
                fallback
            }
        };
        self.psi_low = finite(self.psi_low, 10.0).min(100.0);
        self.psi_critical = finite(self.psi_critical, 30.0).clamp(self.psi_low, 100.0);
        self.os_level_critical = self.os_level_critical.max(self.os_level_low);
        self.available_low_percent = self.available_low_percent.min(100);
        self.available_critical_percent = self
            .available_critical_percent
            .min(self.available_low_percent);
        self.available_critical_floor = self.available_critical_floor.min(self.available_low_floor);
        self.host_rss_critical = self.host_rss_critical.max(self.host_rss_low);
        self.terminal_rss_low_percent = self.terminal_rss_low_percent.min(100);
        self.terminal_rss_critical_percent = self
            .terminal_rss_critical_percent
            .clamp(self.terminal_rss_low_percent, 100);
        self
    }
}

/// The level of one sample: the maximum across its available signals.
pub fn classify(sample: &MemorySample, thresholds: &MemoryThresholds) -> PressureLevel {
    if let Some(forced) = sample.forced {
        return forced;
    }
    let level = |low: bool, critical: bool| {
        if critical {
            PressureLevel::Critical
        } else if low {
            PressureLevel::Low
        } else {
            PressureLevel::Normal
        }
    };
    let mut levels = Vec::with_capacity(5);
    if let Some(psi) = sample.psi_some_avg10 {
        levels.push(level(
            psi >= thresholds.psi_low,
            psi >= thresholds.psi_critical,
        ));
    }
    if let Some(os) = sample.os_level {
        levels.push(level(
            os >= thresholds.os_level_low,
            os >= thresholds.os_level_critical,
        ));
    }
    if let (Some(available), Some(total)) = (sample.available_bytes, sample.total_bytes) {
        let low =
            (total / 100 * thresholds.available_low_percent).max(thresholds.available_low_floor);
        let critical = (total / 100 * thresholds.available_critical_percent)
            .max(thresholds.available_critical_floor);
        levels.push(level(available < low, available < critical));
    }
    if let Some(rss) = sample.host_rss_bytes {
        levels.push(level(
            rss > thresholds.host_rss_low,
            rss > thresholds.host_rss_critical,
        ));
    }
    if let (Some(rss), Some(total)) = (sample.terminal_rss_bytes, sample.total_bytes) {
        let low = total / 100 * thresholds.terminal_rss_low_percent;
        let critical = total / 100 * thresholds.terminal_rss_critical_percent;
        levels.push(level(rss > low, rss > critical));
    }
    levels.into_iter().max().unwrap_or(PressureLevel::Normal)
}

/// Turns raw sample levels into an actionable level and rate-limits pressure closes.
#[derive(Debug, Clone)]
pub struct PressureGovernor {
    history: VecDeque<PressureLevel>,
    effective: PressureLevel,
    closes: VecDeque<u64>,
    last_no_candidate: Option<u64>,
}

impl Default for PressureGovernor {
    fn default() -> Self {
        Self {
            history: VecDeque::with_capacity(SAMPLES_TO_CLEAR),
            effective: PressureLevel::Normal,
            closes: VecDeque::new(),
            last_no_candidate: None,
        }
    }
}

impl PressureGovernor {
    /// A level must hold for 2 samples to act; pressure clears after 3 samples below Low.
    pub fn observe(&mut self, level: PressureLevel) -> PressureLevel {
        if self.history.len() == SAMPLES_TO_CLEAR {
            self.history.pop_front();
        }
        self.history.push_back(level);
        let recent = |count: usize| self.history.iter().rev().take(count);
        let held = (self.history.len() >= SAMPLES_TO_ACT)
            .then(|| recent(SAMPLES_TO_ACT).copied().min())
            .flatten()
            .unwrap_or(PressureLevel::Normal);
        let cleared = self.history.len() == SAMPLES_TO_CLEAR
            && recent(SAMPLES_TO_CLEAR).all(|level| *level == PressureLevel::Normal);
        if held > PressureLevel::Normal {
            self.effective = held;
        } else if cleared {
            self.effective = PressureLevel::Normal;
        }
        self.effective
    }

    pub fn level(&self) -> PressureLevel {
        self.effective
    }

    /// One close, then 30 s before the next; at most 3 per 5 minutes (6 at Critical).
    pub fn may_close(&mut self, now: u64) -> bool {
        while self
            .closes
            .front()
            .is_some_and(|at| now.saturating_sub(*at) >= CLOSE_WINDOW_MS)
        {
            self.closes.pop_front();
        }
        let cap = match self.effective {
            PressureLevel::Normal => return false,
            PressureLevel::Low => 3,
            PressureLevel::Critical => 6,
        };
        let spaced = self
            .closes
            .back()
            .is_none_or(|at| now.saturating_sub(*at) >= CLOSE_SPACING_MS);
        spaced && self.closes.len() < cap
    }

    pub fn record_close(&mut self, now: u64) {
        self.closes.push_back(now);
    }

    /// `pressure_no_candidate` is emitted at most once per 10 minutes.
    pub fn take_no_candidate_notice(&mut self, now: u64) -> bool {
        let due = self
            .last_no_candidate
            .is_none_or(|at| now.saturating_sub(at) >= NO_CANDIDATE_INTERVAL_MS);
        if due {
            self.last_no_candidate = Some(now);
        }
        due
    }
}
