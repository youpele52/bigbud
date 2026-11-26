//! One policy tick over the host's PTYs (plan §8.5-§8.7, §14 "several owners"). The caller
//! (the supervisor's policy loop, or a test with a fake clock) supplies the PTYs and runs the
//! tick about once a second; the tick probes, evaluates, emits notices and activity, and closes
//! under each PTY's lock. Unmanaged PTYs are never touched.

use std::sync::Arc;
use std::time::{Duration, Instant};

use bigbud_protocol::v1;

use crate::terminal_policy::{PolicyAction, TerminalRef, is_pressure_candidate};

use super::pty_lifecycle::PtyLifecycle;
use super::pty_lifecycle_host::{HostLifecycle, kind};

/// Foreground probes run every 2 s per managed PTY (§13).
pub(crate) const PROBE_INTERVAL_MS: u64 = 2_000;
/// A spool checkpoint may wait this long for the actor's fence before retrying next tick.
const CHECKPOINT_FENCE: Duration = Duration::from_millis(250);

impl HostLifecycle {
    /// Runs one tick and returns the ids of PTYs this tick closed, for session retention.
    pub(crate) fn run_policy(&self, ptys: &[Arc<PtyLifecycle>]) -> Vec<String> {
        let now = self.now_ms();
        let policy = self.policy();
        let mut ptys = ptys.to_vec();
        ptys.sort_by(|left, right| left.pty_id().cmp(right.pty_id()));
        self.probe_foreground(&ptys, now);
        let mut actions = Vec::new();
        let mut activity = Vec::new();
        {
            let mut guards = ptys
                .iter()
                .filter(|pty| pty.is_live())
                .map(|pty| (pty, pty.lock()))
                .collect::<Vec<_>>();
            let mut refs = guards
                .iter_mut()
                .map(|(pty, state)| TerminalRef {
                    pty_id: pty.pty_id(),
                    activity: &mut state.activity,
                })
                .collect::<Vec<_>>();
            let mut engine = self
                .engine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            actions.extend(engine.evaluate(now, &policy, &mut refs));
            drop(engine);
            drop(refs);
            for (pty, state) in &mut guards {
                if !pty.managed() {
                    continue;
                }
                let facts = (
                    state.activity.idle_busy(),
                    state.activity.pressure_busy(now),
                    state.activity.sidebar_busy(now),
                );
                if state.reported != Some(facts) {
                    state.reported = Some(facts);
                    activity.push(activity_frame(pty.pty_id(), &state.activity, facts, now));
                }
            }
        }
        for frame in &activity {
            self.broadcast(frame);
        }
        let mut closed = Vec::new();
        for action in actions {
            self.apply_action(&ptys, action, &mut closed);
        }
        self.enforce_orphan(&ptys, &policy, now, &mut closed);
        for pty in &ptys {
            pty.try_rebuild();
        }
        // At most one spool checkpoint per tick, least recently checkpointed first, and only
        // once output paused (or a while has passed): each checkpoint clones the whole model,
        // and clones taken mid-flood were the host's main source of heap fragmentation (R7).
        let due = ptys
            .iter()
            .filter(|pty| pty.checkpoint_due(now))
            .min_by_key(|pty| pty.lock().last_checkpoint_ms);
        if let Some(pty) = due {
            pty.checkpoint(false, Instant::now() + CHECKPOINT_FENCE);
        }
        closed
    }

    fn probe_foreground(&self, ptys: &[Arc<PtyLifecycle>], now: u64) {
        for pty in ptys.iter().filter(|pty| pty.managed() && pty.is_live()) {
            let due = {
                let mut state = pty.lock();
                let due = state.next_probe_at <= now;
                if due {
                    state.next_probe_at = now.saturating_add(PROBE_INTERVAL_MS);
                }
                due
            };
            if !due {
                continue;
            }
            // An unreadable probe counts as a program: the rule never errs toward idle.
            let foreground = pty.handle().foreground_program(&self.probe).unwrap_or(true);
            pty.lock().activity.set_foreground_program(foreground, now);
        }
    }

    fn apply_action(
        &self,
        ptys: &[Arc<PtyLifecycle>],
        action: PolicyAction,
        closed: &mut Vec<String>,
    ) {
        let find = |id: &str| ptys.iter().find(|pty| pty.pty_id() == id);
        match action {
            PolicyAction::IdleWarning { pty_id, closes_at } => {
                if let Some(pty) = find(&pty_id) {
                    // The idle transition is a checkpoint point (§8.3).
                    pty.checkpoint(true, Instant::now() + CHECKPOINT_FENCE);
                }
                self.notice(&pty_id, kind::IDLE_WARNING, closes_at);
            }
            PolicyAction::IdleWarningCleared { pty_id } => {
                self.notice(&pty_id, kind::IDLE_WARNING_CLEARED, 0);
            }
            PolicyAction::IdleClose { pty_id } => {
                if let Some(pty) = find(&pty_id)
                    && pty.close_if(kind::IDLE_CLOSED, |activity, now| activity.still_idle(now))
                {
                    closed.push(pty_id);
                }
            }
            PolicyAction::PressureClose { pty_id } => {
                if let Some(pty) = find(&pty_id)
                    && pty.close_if(kind::PRESSURE_CLOSED, is_pressure_candidate)
                {
                    closed.push(pty_id);
                }
            }
            PolicyAction::PressureNoCandidate => {
                self.notice("", kind::PRESSURE_NO_CANDIDATE, 0);
            }
        }
    }

    /// Default mode: with no owner connected for `orphan_ms`, managed PTYs close
    /// (`orphan_closed`). Keep mode pushes `orphan_ms = 0` and never closes.
    fn enforce_orphan(
        &self,
        ptys: &[Arc<PtyLifecycle>],
        policy: &crate::terminal_policy::HostPolicy,
        now: u64,
        closed: &mut Vec<String>,
    ) {
        if !policy.lifecycle_enabled || policy.orphan_ms == 0 || self.owners() > 0 {
            return;
        }
        let Some(since) = self.orphaned_since() else {
            return;
        };
        if now.saturating_sub(since) < policy.orphan_ms {
            return;
        }
        for pty in ptys.iter().filter(|pty| pty.managed()) {
            if pty.close_if(kind::ORPHAN_CLOSED, |_, _| true) {
                closed.push(pty.pty_id().to_owned());
            }
        }
    }
}

fn activity_frame(
    pty_id: &str,
    activity: &crate::terminal_policy::ActivityTracker,
    (idle_busy, pressure_busy, sidebar_busy): (bool, bool, bool),
    now: u64,
) -> v1::Frame {
    let mut reasons = Vec::new();
    if activity.foreground_program() {
        reasons.push("foreground_program".to_owned());
    }
    if idle_busy && !activity.foreground_program() {
        reasons.push("owner_hint".to_owned());
    }
    if activity.recent_output(now, crate::terminal_policy::PRESSURE_OUTPUT_WINDOW_MS) {
        reasons.push("recent_output".to_owned());
    }
    v1::Frame {
        payload: Some(v1::frame::Payload::PtyActivity(v1::PtyActivity {
            pty_id: pty_id.to_owned(),
            idle_busy,
            pressure_busy,
            sidebar_busy,
            reasons,
            last_input_ms: activity.last_input().unwrap_or(0),
            last_output_ms: activity.last_output().unwrap_or(0),
            quiet_since_ms: activity.quiet_since(),
        })),
    }
}
