//! Suspend-inclusive deadline rules (M5). Inputs are guard native-clock
//! nanoseconds (macOS continuous time; Linux CLOCK_BOOTTIME / Windows
//! unbiased-uptime sources still need their own qualified readers). These
//! values are NEVER persisted: an armed restart is paused, not resumed.
use super::limits::{MAX_ACTION_TIMEOUT, MAX_CHECK_IN, MIN_ACTION_TIMEOUT, MIN_CHECK_IN};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitError {
    OutOfRange,
}

fn nanos(value: Duration) -> u64 {
    u64::try_from(value.as_nanos()).unwrap_or(u64::MAX)
}
pub fn check_in_limit(value: Duration) -> Result<u64, LimitError> {
    (MIN_CHECK_IN..=MAX_CHECK_IN)
        .contains(&value)
        .then(|| nanos(value))
        .ok_or(LimitError::OutOfRange)
}
pub fn action_timeout(value: Duration) -> Result<u64, LimitError> {
    (MIN_ACTION_TIMEOUT..=MAX_ACTION_TIMEOUT)
        .contains(&value)
        .then(|| nanos(value))
        .ok_or(LimitError::OutOfRange)
}

/// Desktop check-in. Anchored by the first actual primitive of an episode;
/// turns, tool gaps, reconnects and chat never reset it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckIn {
    limit: u64,
    pending_growth: Option<u64>,
    anchor: Option<u64>,
    deadline: Option<u64>,
}
impl CheckIn {
    pub fn new(limit_ns: u64) -> Self {
        Self {
            limit: limit_ns,
            pending_growth: None,
            anchor: None,
            deadline: None,
        }
    }
    pub fn deadline(&self) -> Option<u64> {
        self.deadline
    }
    /// Called before every primitive; anchors only the first one.
    pub fn primitive(&mut self, now: u64) {
        if self.anchor.is_none() {
            self.rearm(now);
        }
    }
    /// Only a trusted human Continue re-anchors (and applies growth).
    pub fn human_continue(&mut self, now: u64) {
        self.rearm(now);
    }
    /// A fully settled new episode starts unanchored (fresh first primitive).
    pub fn new_episode(&mut self) {
        if let Some(limit) = self.pending_growth.take() {
            self.limit = limit;
        }
        self.anchor = None;
        self.deadline = None;
    }
    fn rearm(&mut self, now: u64) {
        if let Some(limit) = self.pending_growth.take() {
            self.limit = limit;
        }
        self.anchor = Some(now);
        self.deadline = Some(now.saturating_add(self.limit));
    }
    /// Shrink: min(old deadline, original anchor + new limit), immediately.
    /// Growth: applies only at the next human continuation or new episode.
    /// Setting the current limit again cancels any pending growth.
    pub fn set_limit(&mut self, limit_ns: u64) {
        if limit_ns > self.limit {
            self.pending_growth = Some(limit_ns);
            return;
        }
        self.pending_growth = None;
        if limit_ns < self.limit {
            self.limit = limit_ns;
            if let (Some(anchor), Some(deadline)) = (self.anchor, self.deadline) {
                self.deadline = Some(deadline.min(anchor.saturating_add(limit_ns)));
            }
        }
    }
    /// Checked before every helper, in the <=100 ms loop and first on wake.
    pub fn expired(&self, now: u64) -> bool {
        self.deadline.is_some_and(|deadline| now >= deadline)
    }
}

/// Operation deadline fixed at acceptance; covers queueing, every helper and
/// chunk and post-action capture. Reconnect/chunking never extends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperationDeadline {
    accepted: u64,
    deadline: u64,
}
impl OperationDeadline {
    pub fn accept(now: u64, timeout_ns: u64) -> Self {
        Self {
            accepted: now,
            deadline: now.saturating_add(timeout_ns),
        }
    }
    pub fn deadline(&self) -> u64 {
        self.deadline
    }
    /// Limit shrink tightens outstanding work; increases never extend it.
    pub fn apply_limit(&mut self, timeout_ns: u64) {
        self.deadline = self.deadline.min(self.accepted.saturating_add(timeout_ns));
    }
    pub fn expired(&self, now: u64) -> bool {
        now >= self.deadline
    }
}
