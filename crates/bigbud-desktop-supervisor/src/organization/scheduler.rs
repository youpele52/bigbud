//! One global deterministic coordinator. Facts remain TypeScript-owned; this module
//! neither reads a database nor assumes that a proposal has committed.
use super::protocol::facts::v1::{Section, ThreadFacts, Work};
use super::timing::{CleanupRule, CleanupTiming, ClockSample, RuleWait};
use thiserror::Error;

pub const MAX_TARGET: usize = 100_000;
pub const MANUAL_OVERRIDE_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedulingPolicy {
    pub version: u64,
    pub idle: RuleWait,
    pub idle_destination: Section,
    pub older: RuleWait,
    pub target: Option<usize>,
    pub target_not_before_ms: Option<u64>,
    pub grace_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("invalid organisation scheduling policy")]
pub struct InvalidPolicy;

impl SchedulingPolicy {
    pub fn validate(self) -> Result<Self, InvalidPolicy> {
        if self.version == 0
            || !(120_000..=600_000).contains(&self.grace_ms)
            || self
                .target
                .is_some_and(|target| target == 0 || target > MAX_TARGET)
            || !matches!(self.idle_destination, Section::Later | Section::Done)
            || self.idle.enabled && self.idle.timeout_ms == 0
            || self.older.enabled && self.older.timeout_ms == 0
        {
            return Err(InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SchedulingFacts<'a> {
    pub row: &'a ThreadFacts,
    /// Live standard thread across all projects, independent of age classification.
    pub in_scope: bool,
    /// Already-reconciled/stale or deferred candidates still count toward the global target.
    pub decision_allowed: bool,
    /// Captured when the explicit move was accepted, not the current request watermark.
    pub manual_attention_watermark: u64,
    /// Server-clamped maximum across live client leases. Stored drafts are not engagement.
    pub engaged_until_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MovementReason {
    Attention,
    Active,
    SnoozeExpired,
    Older,
    Idle,
    Target,
    /// Automatic Needs you placement whose requests were all answered.
    Resolved,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movement {
    pub thread_id: String,
    pub fact_version: u64,
    pub expected_revision: u64,
    pub policy_version: u64,
    pub from: Section,
    pub destination: Section,
    pub reason: MovementReason,
    pub snooze_identity: String,
    pub inactivity_cutoff_ms: Option<u64>,
}

pub struct Scheduler {
    timing: CleanupTiming,
    policy: SchedulingPolicy,
}

impl Scheduler {
    pub fn new(
        now: ClockSample,
        older_barrier: Option<i64>,
        policy: SchedulingPolicy,
    ) -> Result<Self, InvalidPolicy> {
        Ok(Self {
            timing: CleanupTiming::new(now, older_barrier),
            policy: policy.validate()?,
        })
    }

    /// Policy barriers must have been persisted before supplying this update.
    pub fn update_policy(
        &mut self,
        now: ClockSample,
        policy: SchedulingPolicy,
    ) -> Result<(), InvalidPolicy> {
        let policy = policy.validate()?;
        // The same version may only advance the target drain barrier (Undo/target grace).
        let same_except_barrier = SchedulingPolicy {
            target_not_before_ms: self.policy.target_not_before_ms,
            ..policy
        } == self.policy;
        if policy.version < self.policy.version
            || policy.version == self.policy.version
                && (!same_except_barrier
                    || policy.target_not_before_ms < self.policy.target_not_before_ms)
        {
            return Err(InvalidPolicy);
        }
        if policy.idle != self.policy.idle
            || policy.idle_destination != self.policy.idle_destination
        {
            self.timing.policy_changed(CleanupRule::Idle, now);
        }
        if policy.older != self.policy.older {
            self.timing.policy_changed(CleanupRule::Older, now);
        }
        self.policy = policy;
        Ok(())
    }

    /// Return ONE proposal. The owner must reconcile its committed outcome and fresh facts
    /// before asking again, so concurrent target checks cannot over-evict. Protected rows
    /// never occupy a fixed front page: selection considers the complete admitted snapshot.
    pub fn next(&mut self, now: ClockSample, rows: &[SchedulingFacts<'_>]) -> Option<Movement> {
        let cutoffs = self
            .timing
            .due_cutoffs(now, self.policy.idle, self.policy.older);
        let now_ms = u64::try_from(now.wall_ms).ok()?;
        // Reactions have priority over tidying. Stable ID ordering avoids source arrival bias.
        let reaction = rows
            .iter()
            .filter_map(|facts| self.reaction(now_ms, *facts))
            .min_by(|left, right| left.thread_id.cmp(&right.thread_id));
        if reaction.is_some() {
            return reaction;
        }
        for (rule, cutoff) in cutoffs {
            let cutoff = cutoff.and_then(|cutoff| u64::try_from(cutoff).ok());
            let Some(cutoff) = cutoff else {
                continue;
            };
            let selected = rows
                .iter()
                .filter(|facts| cleanup_eligible(now_ms, **facts))
                .filter(|facts| match rule {
                    CleanupRule::Older => matches!(
                        Section::try_from(facts.row.section),
                        Ok(Section::Present | Section::Later)
                    ),
                    CleanupRule::Idle => facts.row.section == Section::Present as i32,
                })
                .filter(|facts| {
                    facts
                        .row
                        .inactivity_at_ms
                        .is_some_and(|activity| activity <= cutoff)
                })
                .min_by_key(|facts| (facts.row.inactivity_at_ms, &facts.row.thread_id));
            if let Some(facts) = selected {
                let (reason, destination) = match rule {
                    CleanupRule::Older => (MovementReason::Older, Section::Done),
                    CleanupRule::Idle => (MovementReason::Idle, self.policy.idle_destination),
                };
                return Some(self.movement(facts.row, destination, reason, Some(cutoff)));
            }
        }
        let target = self.policy.target?;
        if future(self.policy.target_not_before_ms, now_ms) {
            return None;
        }
        let count = rows
            .iter()
            .filter(|facts| facts.in_scope && facts.row.section == Section::Present as i32)
            .count();
        if count <= target {
            return None;
        }
        let facts = rows
            .iter()
            .filter(|facts| {
                facts.row.section == Section::Present as i32 && cleanup_eligible(now_ms, **facts)
            })
            .min_by_key(|facts| (facts.row.inactivity_at_ms, &facts.row.thread_id))?;
        Some(self.movement(facts.row, Section::Later, MovementReason::Target, None))
    }

    fn reaction(&self, now: u64, facts: SchedulingFacts<'_>) -> Option<Movement> {
        let row = facts.row;
        if !facts.in_scope || !facts.decision_allowed {
            return None;
        }
        let new_attention =
            row.actionable && row.attention_watermark > facts.manual_attention_watermark;
        let manual = future(row.manual_until_ms, now);
        let snoozed = !row.snooze_identity.is_empty();
        // Newly actionable requests interrupt BOTH snooze and manual override immediately.
        if new_attention && (manual || snoozed) {
            return Some(self.movement(row, Section::NeedsYou, MovementReason::Attention, None));
        }
        if manual {
            return None;
        }
        if snoozed {
            return row.snooze_until_ms.filter(|until| *until <= now).map(|_| {
                self.movement(row, Section::NeedsYou, MovementReason::SnoozeExpired, None)
            });
        }
        if row.actionable {
            return (row.section != Section::NeedsYou as i32)
                .then(|| self.movement(row, Section::NeedsYou, MovementReason::Attention, None));
        }
        // Automatic attention placement ends when nothing remains actionable, whatever the work
        // state: returning to Present is not cleanup. Manual placement keeps its own expiry.
        if row.section == Section::NeedsYou as i32 && row.automatic_placement == Some(true) {
            return Some(self.movement(row, Section::Present, MovementReason::Resolved, None));
        }
        if row.work == Work::Active as i32 && row.section != Section::Present as i32 {
            return Some(self.movement(row, Section::Present, MovementReason::Active, None));
        }
        None
    }

    fn movement(
        &self,
        row: &ThreadFacts,
        destination: Section,
        reason: MovementReason,
        cutoff: Option<u64>,
    ) -> Movement {
        Movement {
            thread_id: row.thread_id.clone(),
            fact_version: row.fact_version,
            expected_revision: row.organization_revision,
            policy_version: self.policy.version,
            // Admission validates every section. Unspecified is nevertheless rejected by TS.
            from: Section::try_from(row.section).unwrap_or(Section::Unspecified),
            destination,
            reason,
            snooze_identity: row.snooze_identity.clone(),
            inactivity_cutoff_ms: cutoff,
        }
    }
}

fn future(deadline: Option<u64>, now: u64) -> bool {
    deadline.is_some_and(|deadline| deadline > now)
}
fn cleanup_eligible(now: u64, facts: SchedulingFacts<'_>) -> bool {
    let row = facts.row;
    facts.in_scope
        && facts.decision_allowed
        && row.eligible
        && row.work == Work::Idle as i32
        && !row.actionable
        && row.inactivity_at_ms.is_some()
        && row.snooze_identity.is_empty()
        && !future(row.manual_until_ms, now)
        && !future(row.grace_until_ms, now)
        && !future(facts.engaged_until_ms, now)
}

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod tests;
