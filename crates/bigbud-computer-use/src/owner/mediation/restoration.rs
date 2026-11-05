//! Restoration-bearing routes (plan M2 "Primitive plan and delivery
//! mapping", M2.restoration). Dormant models; no route is qualified yet.
//!
//! 1. Prior-context gate. A route that restores the previously focused
//!    application may run only when that prior context is a resolved,
//!    permitted, unprotected application. A verified foreground prelude may
//!    establish an allowed prior context (the target itself); background
//!    delivery cannot secretly focus to achieve this.
//! 2. Delayed-restoration settlement (pinned Windows
//!    `restore_foreground_polling_best_effort`: up to 1 s wait plus 3 s
//!    polling after the call returns). A normal return is NOT settlement: the
//!    old worker generation must be confirmed retired first. The mutation's
//!    known/unknown completion is fixed at construction and never changes;
//!    there is no replay. A requested `captureAfter` runs only after a known
//!    completed mutation, and only on a replacement generation that
//!    revalidated the retained process lifetime and window (never a
//!    frontmost reselection); any failure or invalidation becomes
//!    `captureError`, never a changed mutation result.
use super::egress::EgressRefusal;
use super::ticket::Delivery;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriorContext {
    Permitted,
    Disallowed,
    Protected,
    Unresolved,
    /// The verified foreground prelude made the target itself the prior
    /// context.
    EstablishedByPrelude,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestorationBlocked;
impl RestorationBlocked {
    pub fn code(self) -> &'static str {
        "restoration_blocked"
    }
}

/// Checked before dispatch of any restoration-bearing route.
pub fn check_prior_context(
    restores: bool,
    delivery: Delivery,
    prior: PriorContext,
) -> Result<(), RestorationBlocked> {
    match (restores, prior) {
        (false, _) | (true, PriorContext::Permitted) => Ok(()),
        (true, PriorContext::EstablishedByPrelude) if delivery == Delivery::Foreground => Ok(()),
        _ => Err(RestorationBlocked),
    }
}

/// The mutation's effect as known when the call returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    Completed,
    Unknown,
}

/// Exact OS identity retained from the mutation's target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedTarget {
    pub pid: u32,
    pub creation_identity: String,
    pub window: u64,
}

/// `captureError` when a capture was requested after a mutation whose
/// effect is unknown: no capture runs (plan: capture only after a known
/// completed action); the frozen code's `observe_again` recovery tells the
/// model to observe deliberately once the state is understood.
pub const UNKNOWN_OUTCOME_CAPTURE_ERROR: &str = "observation_stale";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalidation {
    Stop,
    PolicyChanged,
    ControlLost,
    DeadlineExceeded,
}
impl Invalidation {
    fn code(self) -> &'static str {
        match self {
            Self::Stop => "paused",
            Self::PolicyChanged => "policy_pending",
            Self::ControlLost => "control_unavailable",
            Self::DeadlineExceeded => "deadline_exceeded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreshCapture {
    /// The only generation whose references are usable afterwards.
    pub generation: String,
    pub capture_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settled {
    pub completion: Completion,
    /// Every reference of this generation is invalid.
    pub retired_generation: String,
    /// `None` when no capture was requested; `Err` is the frozen
    /// `captureError` code.
    pub capture: Option<Result<FreshCapture, &'static str>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettlementRefusal {
    /// The event does not fit the current state or names another generation.
    Unexpected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    AwaitingRetirement,
    AwaitingReplacement,
    Capturing { generation: String },
    Settled(Settled),
}

#[derive(Debug)]
pub struct DelayedSettlement {
    completion: Completion,
    target: RetainedTarget,
    old_generation: String,
    capture_requested: bool,
    capture_error: Option<&'static str>,
    state: State,
}

impl DelayedSettlement {
    pub fn new(
        completion: Completion,
        target: RetainedTarget,
        old_generation: &str,
        capture_requested: bool,
    ) -> Self {
        Self {
            completion,
            target,
            old_generation: old_generation.to_owned(),
            capture_requested,
            capture_error: None,
            state: State::AwaitingRetirement,
        }
    }

    pub fn settled(&self) -> Option<&Settled> {
        match &self.state {
            State::Settled(settled) => Some(settled),
            _ => None,
        }
    }

    fn settle(&mut self, capture: Option<Result<FreshCapture, &'static str>>) {
        self.state = State::Settled(Settled {
            completion: self.completion,
            retired_generation: self.old_generation.clone(),
            capture,
        });
    }

    /// Stop, policy, control or deadline invalidation. A pending capture is
    /// abandoned with that `captureError`; retirement is still required.
    pub fn invalidate(&mut self, cause: Invalidation) {
        if self.capture_error.is_none() {
            self.capture_error = Some(cause.code());
        }
        if matches!(
            self.state,
            State::Capturing { .. } | State::AwaitingReplacement
        ) {
            self.settle(Some(Err(cause.code())));
        }
    }

    /// Confirmed physical retirement of exactly the old generation.
    pub fn retirement_confirmed(&mut self, generation: &str) -> Result<(), SettlementRefusal> {
        if self.state != State::AwaitingRetirement || generation != self.old_generation {
            return Err(SettlementRefusal::Unexpected);
        }
        match (self.capture_requested, self.capture_error, self.completion) {
            (false, _, _) => self.settle(None),
            (true, Some(code), _) => self.settle(Some(Err(code))),
            // Only a known completed mutation may be followed by a capture.
            (true, None, Completion::Unknown) => {
                self.settle(Some(Err(UNKNOWN_OUTCOME_CAPTURE_ERROR)));
            }
            (true, None, Completion::Completed) => self.state = State::AwaitingReplacement,
        }
        Ok(())
    }

    /// A replacement generation is ready and re-observed the retained
    /// target. Any identity change refuses the capture as stale. Generations
    /// are owner-issued and never reused; this model only checks that the
    /// replacement is not the retired one.
    pub fn replacement_ready(
        &mut self,
        generation: &str,
        observed: &RetainedTarget,
    ) -> Result<(), SettlementRefusal> {
        if self.state != State::AwaitingReplacement || generation == self.old_generation {
            return Err(SettlementRefusal::Unexpected);
        }
        if *observed != self.target {
            self.settle(Some(Err("target_stale")));
        } else {
            self.state = State::Capturing {
                generation: generation.to_owned(),
            };
        }
        Ok(())
    }

    /// Outcome of the fresh qualified capture on the replacement generation
    /// (its capture id, or the egress refusal's frozen code).
    pub fn capture_result(
        &mut self,
        generation: &str,
        result: Result<String, EgressRefusal>,
    ) -> Result<(), SettlementRefusal> {
        let State::Capturing {
            generation: current,
        } = &self.state
        else {
            return Err(SettlementRefusal::Unexpected);
        };
        if current != generation {
            return Err(SettlementRefusal::Unexpected);
        }
        let generation = current.clone();
        let capture = result
            .map(|capture_id| FreshCapture {
                generation,
                capture_id,
            })
            .map_err(EgressRefusal::code);
        self.settle(Some(capture));
        Ok(())
    }
}
