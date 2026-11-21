//! Host lifecycle policy (plan §8.7): off by default, applied only to managed PTYs, clamped in
//! Rust, and the latest pushed revision wins.

use super::activity_idle::IdleTimings;
use super::pressure::MemoryThresholds;

pub const MIN_IDLE_MS: u64 = 60_000;
pub const MIN_ORPHAN_MS: u64 = 60_000;
pub const MAX_LIVE_PTYS_CEILING: u32 = 40;
pub const DEFAULT_MAX_LIVE_PTYS: u32 = 24;
/// Debug builds only: replaces the idle timeout of every applied policy, so real-process tests
/// can watch the warning and the close (plan Q1). The warning lead becomes at most half of it.
pub const IDLE_OVERRIDE_ENV: &str = "BIGBUD_DEBUG_TERMINAL_IDLE_MS";
/// The shortest debug idle timeout honoured.
pub const MIN_DEBUG_IDLE_MS: u64 = 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct HostPolicy {
    pub lifecycle_enabled: bool,
    pub idle_ms: u64,
    /// Lead time of the idle warning before the close.
    pub warning_ms: u64,
    pub max_live_ptys: u32,
    /// 0 keeps orphaned PTYs forever.
    pub orphan_ms: u64,
    pub memory: MemoryThresholds,
    pub revision: u64,
}

impl Default for HostPolicy {
    fn default() -> Self {
        Self {
            lifecycle_enabled: false,
            idle_ms: 600_000,
            warning_ms: 60_000,
            max_live_ptys: DEFAULT_MAX_LIVE_PTYS,
            orphan_ms: 600_000,
            memory: MemoryThresholds::default(),
            revision: 0,
        }
    }
}

impl HostPolicy {
    /// Clamps every value into its safe range: idle ≥ 60 s, warning ≤ idle/2, limit 1..=40,
    /// orphan 0 or ≥ 60 s, and memory thresholds ordered.
    pub fn clamped(mut self) -> Self {
        self.idle_ms = self.idle_ms.max(MIN_IDLE_MS);
        self.warning_ms = self.warning_ms.min(self.idle_ms / 2);
        self.max_live_ptys = self.max_live_ptys.clamp(1, MAX_LIVE_PTYS_CEILING);
        if self.orphan_ms != 0 {
            self.orphan_ms = self.orphan_ms.max(MIN_ORPHAN_MS);
        }
        self.memory = self.memory.clamped();
        self
    }

    /// The policy with a debug idle timeout, when one is given and at least `MIN_DEBUG_IDLE_MS`.
    pub fn with_idle_override(self, idle_ms: Option<u64>) -> Self {
        match idle_ms {
            Some(idle_ms) if idle_ms >= MIN_DEBUG_IDLE_MS => Self {
                idle_ms,
                warning_ms: self.warning_ms.min(idle_ms / 2),
                ..self
            },
            _ => self,
        }
    }

    pub fn idle_timings(&self) -> IdleTimings {
        IdleTimings {
            idle_ms: self.idle_ms,
            warning_ms: self.warning_ms,
        }
    }
}

/// The effective policy of one host.
#[derive(Debug, Clone, Default)]
pub struct PolicyState {
    current: HostPolicy,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PolicyUpdate {
    /// Applied; carries the effective clamped values for the response.
    Applied(HostPolicy),
    /// Older than the current revision; the current values stay.
    Stale(HostPolicy),
}

impl PolicyState {
    pub fn current(&self) -> &HostPolicy {
        &self.current
    }

    /// Applies an update unless an owner already pushed a newer revision. An equal revision is
    /// re-applied, so the latest push of the same revision wins too.
    pub fn apply(&mut self, update: HostPolicy) -> PolicyUpdate {
        if update.revision < self.current.revision {
            return PolicyUpdate::Stale(self.current.clone());
        }
        self.current = update.clamped().with_idle_override(debug_idle_ms());
        PolicyUpdate::Applied(self.current.clone())
    }
}

/// `IDLE_OVERRIDE_ENV` in debug builds; release builds never read it.
fn debug_idle_ms() -> Option<u64> {
    #[cfg(debug_assertions)]
    {
        std::env::var(IDLE_OVERRIDE_ENV)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}
