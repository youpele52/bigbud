//! `PolicyEngine::evaluate`: the per-tick decision over the host's managed PTYs. Unmanaged
//! PTYs are never touched; with lifecycle off, nothing is closed (plan §8.7).

use super::activity::{ActivityTracker, ViewState};
use super::activity_idle::IdleEvent;
use super::policy::HostPolicy;
use super::pressure::{PressureGovernor, PressureLevel};

/// One live PTY as the engine sees it.
pub struct TerminalRef<'a> {
    pub pty_id: &'a str,
    pub activity: &'a mut ActivityTracker,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyAction {
    IdleWarning {
        pty_id: String,
        closes_at: u64,
    },
    IdleWarningCleared {
        pty_id: String,
    },
    /// Re-check `still_idle` under the PTY lock, then close and emit `idle_closed`.
    IdleClose {
        pty_id: String,
    },
    /// Re-check the candidate under the PTY lock, then close and emit `pressure_closed`.
    PressureClose {
        pty_id: String,
    },
    PressureNoCandidate,
}

#[derive(Debug, Clone, Default)]
pub struct PolicyEngine {
    governor: PressureGovernor,
}

impl PolicyEngine {
    /// Feeds one memory sample's level (every 10 s); returns the actionable level.
    pub fn observe_memory(&mut self, level: PressureLevel) -> PressureLevel {
        self.governor.observe(level)
    }

    pub fn pressure_level(&self) -> PressureLevel {
        self.governor.level()
    }

    pub fn evaluate(
        &mut self,
        now: u64,
        policy: &HostPolicy,
        terminals: &mut [TerminalRef<'_>],
    ) -> Vec<PolicyAction> {
        let mut actions = Vec::new();
        if !policy.lifecycle_enabled {
            for terminal in terminals.iter_mut() {
                if terminal.activity.clear_warning() {
                    actions.push(PolicyAction::IdleWarningCleared {
                        pty_id: terminal.pty_id.to_owned(),
                    });
                }
            }
            return actions;
        }
        let timings = policy.idle_timings();
        let mut closing = Vec::new();
        for terminal in terminals.iter_mut() {
            if !terminal.activity.lifecycle_managed() {
                continue;
            }
            let pty_id = terminal.pty_id.to_owned();
            match terminal.activity.evaluate_idle(now, timings) {
                Some(IdleEvent::Warning { closes_at }) => {
                    actions.push(PolicyAction::IdleWarning { pty_id, closes_at });
                }
                Some(IdleEvent::WarningCleared) => {
                    actions.push(PolicyAction::IdleWarningCleared { pty_id });
                }
                Some(IdleEvent::Close) => {
                    closing.push(terminal.pty_id);
                    actions.push(PolicyAction::IdleClose { pty_id });
                }
                None => {}
            }
        }
        if let Some(action) = self.pressure_action(now, terminals, &closing) {
            actions.push(action);
        }
        actions
    }

    fn pressure_action(
        &mut self,
        now: u64,
        terminals: &[TerminalRef<'_>],
        closing: &[&str],
    ) -> Option<PolicyAction> {
        if self.governor.level() == PressureLevel::Normal || !self.governor.may_close(now) {
            return None;
        }
        let candidate = terminals
            .iter()
            .filter(|terminal| is_pressure_candidate(terminal.activity, now))
            .filter(|terminal| !closing.contains(&terminal.pty_id))
            .min_by_key(|terminal| (terminal.activity.last_used(), terminal.pty_id));
        match candidate {
            Some(terminal) => {
                self.governor.record_close(now);
                Some(PolicyAction::PressureClose {
                    pty_id: terminal.pty_id.to_owned(),
                })
            }
            None => self
                .governor
                .take_no_candidate_notice(now)
                .then_some(PolicyAction::PressureNoCandidate),
        }
    }
}

/// Managed, hidden, not pressure-busy (no foreground program, owner hint not busy or unknown,
/// no output in the last 10 minutes). Never a visible or busy terminal.
pub fn is_pressure_candidate(activity: &ActivityTracker, now: u64) -> bool {
    activity.lifecycle_managed()
        && activity.view_state() == ViewState::Hidden
        && !activity.pressure_busy(now)
}
