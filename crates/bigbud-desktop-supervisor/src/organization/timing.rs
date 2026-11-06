/// The existing sweep interval (15s) plus its allowed discontinuity (60s).
const MAX_TICK_GAP_MS: i128 = 75_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupRule {
    Idle,
    Older,
}

/// Wall time is durable; monotonic time belongs only to this process incarnation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockSample {
    pub wall_ms: i64,
    pub monotonic_ms: u64,
}

/// Configuration validation and policy-change detection belong to the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuleWait {
    pub enabled: bool,
    pub timeout_ms: u64,
}

/// Timing gates only, not permission to move a thread. The scheduler must also
/// check source-aware inactivity, current work/attention, revisions and ownership.
///
/// Persist the older policy barrier in TypeScript before accepting its policy
/// change. Pass that same barrier on restart; never persist monotonic samples.
#[derive(Debug)]
pub struct CleanupTiming {
    idle_barrier: ClockSample,
    older_policy_changed_at_ms: Option<i64>,
    last_tick: ClockSample,
}

impl CleanupTiming {
    /// Short idle always waits again after startup. Older inactivity does not:
    /// `None` means no explicit policy barrier, not an unknown activity fact.
    pub fn new(now: ClockSample, older_policy_changed_at_ms: Option<i64>) -> Self {
        Self {
            idle_barrier: now,
            older_policy_changed_at_ms,
            last_tick: now,
        }
    }

    /// Call only for a genuine change to this rule, including enabling it or
    /// changing its destination. Repeated settings observations must not call it.
    pub fn policy_changed(&mut self, rule: CleanupRule, now: ClockSample) {
        match rule {
            CleanupRule::Idle => self.idle_barrier = now,
            CleanupRule::Older => self.older_policy_changed_at_ms = Some(now.wall_ms),
        }
    }

    pub fn older_policy_changed_at_ms(&self) -> Option<i64> {
        self.older_policy_changed_at_ms
    }

    /// Call on each regular sweep, even with both rules disabled. Returns the
    /// activity cutoffs in older-before-idle order. `None` means no candidate
    /// may be proposed for that rule on this tick.
    ///
    /// A long pause, clock rollback or monotonic reset restarts only short idle.
    /// A smaller forward wall-clock correction cannot shorten its live wait.
    /// Older age and policy grace deliberately follow persisted wall time.
    pub fn due_cutoffs(
        &mut self,
        now: ClockSample,
        idle: RuleWait,
        older: RuleWait,
    ) -> [(CleanupRule, Option<i64>); 2] {
        let wall_elapsed = i128::from(now.wall_ms) - i128::from(self.last_tick.wall_ms);
        let monotonic_elapsed = now.monotonic_ms.checked_sub(self.last_tick.monotonic_ms);
        if !(0..=MAX_TICK_GAP_MS).contains(&wall_elapsed)
            || monotonic_elapsed.is_none_or(|elapsed| i128::from(elapsed) > MAX_TICK_GAP_MS)
        {
            self.idle_barrier = now;
        }
        self.last_tick = now;

        [
            (CleanupRule::Older, self.older_cutoff(now, older)),
            (CleanupRule::Idle, self.idle_cutoff(now, idle)),
        ]
    }

    fn older_cutoff(&self, now: ClockSample, wait: RuleWait) -> Option<i64> {
        if let Some(barrier) = self.older_policy_changed_at_ms
            && !wall_wait_elapsed(barrier, now.wall_ms, wait.timeout_ms)
        {
            return None;
        }
        activity_cutoff(now.wall_ms, wait)
    }

    fn idle_cutoff(&self, now: ClockSample, wait: RuleWait) -> Option<i64> {
        if !wall_wait_elapsed(self.idle_barrier.wall_ms, now.wall_ms, wait.timeout_ms)
            || now
                .monotonic_ms
                .checked_sub(self.idle_barrier.monotonic_ms)
                .is_none_or(|elapsed| elapsed < wait.timeout_ms)
        {
            return None;
        }
        activity_cutoff(now.wall_ms, wait)
    }
}

fn wall_wait_elapsed(start: i64, now: i64, timeout_ms: u64) -> bool {
    i128::from(now) - i128::from(start) >= i128::from(timeout_ms)
}

fn activity_cutoff(now: i64, wait: RuleWait) -> Option<i64> {
    if !wait.enabled {
        return None;
    }
    // An unrepresentable cutoff cannot make any representable activity eligible.
    // Do not saturate to MIN: that would incorrectly admit activity at MIN.
    i64::try_from(i128::from(now) - i128::from(wait.timeout_ms)).ok()
}

#[cfg(test)]
#[path = "timing_tests.rs"]
mod tests;
