//! The idle/warning state machine (plan §8.5). One warning per quiet period; new input,
//! output, focus, Keep open, or a foreground program starting clears it and starts a new
//! period. Output aging out of a window never clears anything: only `quiet_since` matters.

use super::activity::{ActivityTracker, IdleWarning};

/// Idle timings after clamping (`HostPolicy`). `warning_ms` is the lead before the close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdleTimings {
    pub idle_ms: u64,
    pub warning_ms: u64,
}

impl Default for IdleTimings {
    fn default() -> Self {
        Self {
            idle_ms: 600_000,
            warning_ms: 60_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleEvent {
    /// Emit `idle_warning { closes_at }`.
    Warning { closes_at: u64 },
    /// Emit `idle_warning_cleared`.
    WarningCleared,
    /// The deadline passed: re-check with [`ActivityTracker::still_idle`] under the PTY lock,
    /// then close (`terminate = true`) and emit `idle_closed`.
    Close,
}

impl ActivityTracker {
    /// Advances the state machine. Call it on every policy tick and after any fact changes.
    pub fn evaluate_idle(&mut self, now: u64, timings: IdleTimings) -> Option<IdleEvent> {
        let quiet = self.quiet_since();
        if let Some(warning) = self.warning {
            if !self.idle_eligible() || warning.period != quiet {
                self.warning = None;
                return Some(IdleEvent::WarningCleared);
            }
            return (now >= warning.closes_at).then_some(IdleEvent::Close);
        }
        if !self.idle_eligible() {
            return None;
        }
        let closes_at = quiet.saturating_add(timings.idle_ms);
        let warn_at = closes_at.saturating_sub(timings.warning_ms);
        if now < warn_at {
            return None;
        }
        // A late tick (host suspended, policy just enabled) still gives the full lead time
        // instead of closing without a visible warning.
        let closes_at = if now >= closes_at {
            now.saturating_add(timings.warning_ms)
        } else {
            closes_at
        };
        self.warning = Some(IdleWarning {
            period: quiet,
            closes_at,
        });
        Some(IdleEvent::Warning { closes_at })
    }

    /// The close-time re-check: the warning still belongs to the current quiet period, the
    /// terminal is still eligible and the deadline has passed.
    pub fn still_idle(&self, now: u64) -> bool {
        self.idle_eligible()
            && self.warning.is_some_and(|warning| {
                warning.period == self.quiet_since() && now >= warning.closes_at
            })
    }

    /// Drops a pending warning without a new period (policy disabled). Returns whether one
    /// was pending, in which case the caller emits `idle_warning_cleared`.
    pub fn clear_warning(&mut self) -> bool {
        self.warning.take().is_some()
    }
}
