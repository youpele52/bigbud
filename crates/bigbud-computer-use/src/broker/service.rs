use super::BrokerRequest;
use crate::owner::admission::ledger::{Admit, Completion, Ledger, Outcome, Refusal};
use std::io;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launched {
    pub pid: u32,
    pub creation_identity: String,
}
#[derive(Debug)]
pub enum LaunchFailure {
    /// The OS never received the request.
    NotSubmitted(io::Error),
    /// Submitted; the outcome is not knowable (never resubmit).
    Unknown(io::Error),
}
pub trait LaunchBackend {
    fn launch(&mut self, request: &BrokerRequest) -> Result<Launched, LaunchFailure>;
}
/// Production backend: exact-app OS launch APIs are not linked (approval).
pub struct UnavailableBackend;
impl LaunchBackend for UnavailableBackend {
    fn launch(&mut self, _: &BrokerRequest) -> Result<Launched, LaunchFailure> {
        Err(LaunchFailure::NotSubmitted(io::Error::new(
            io::ErrorKind::Unsupported,
            "exact-app launch backend requires unapproved OS framework linkage",
        )))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerOutcome {
    NotStarted,
    Launched(Launched),
    Unknown,
    /// Deterministic duplicate: the original outcome, never a second launch.
    Duplicate(crate::owner::admission::ledger::Lookup),
}

pub struct Broker<B> {
    pub(super) backend: B,
    ledger: Ledger,
    tracked: Vec<Launched>,
}
impl<B: LaunchBackend> Broker<B> {
    pub fn new(backend: B, generation: &str) -> Option<Self> {
        Some(Self {
            backend,
            ledger: Ledger::new(generation)?,
            tracked: Vec::new(),
        })
    }
    /// Launched processes are recorded for later target identity checks only.
    pub fn tracked(&self) -> &[Launched] {
        &self.tracked
    }

    /// Owner-issued caller session for a trusted server thread identity.
    pub fn open_caller(&mut self, thread: &str) -> Result<String, Refusal> {
        self.ledger.open_caller(thread)
    }
    pub fn retire_caller(&mut self, caller: &str) -> Result<(), Refusal> {
        // The broker keeps no AuthorityTable, so there is nothing to forget.
        self.ledger.retire_caller(caller).map(drop)
    }

    /// One submission per (caller session, `<label>.<sequence>` operation).
    /// `cancelled` reports a cancellation that reached the broker first.
    pub fn submit(
        &mut self,
        (generation, caller, operation): (&str, &str, &str),
        digest: [u8; 32],
        request: &BrokerRequest,
        cancelled: bool,
        now_ns: u64,
    ) -> Result<BrokerOutcome, Refusal> {
        let ticket = match self
            .ledger
            .admit(generation, caller, operation, digest, now_ns)?
        {
            Admit::Duplicate(lookup) => return Ok(BrokerOutcome::Duplicate(lookup)),
            Admit::New(admitted) => admitted.number,
        };
        let (outcome, completion, code) = if cancelled {
            (
                BrokerOutcome::NotStarted,
                Completion::NotStarted,
                "cancelled",
            )
        } else {
            match self.backend.launch(request) {
                Ok(launched) => {
                    self.tracked.push(launched.clone());
                    if self.tracked.len() > 64 {
                        self.tracked.remove(0);
                    }
                    (
                        BrokerOutcome::Launched(launched),
                        Completion::Completed,
                        "launched",
                    )
                }
                Err(LaunchFailure::NotSubmitted(_)) => (
                    BrokerOutcome::NotStarted,
                    Completion::NotStarted,
                    "launch_unavailable",
                ),
                Err(LaunchFailure::Unknown(_)) => (
                    BrokerOutcome::Unknown,
                    Completion::Unknown,
                    "launch_unknown",
                ),
            }
        };
        let settled = Outcome {
            completion,
            code: code.into(),
            policy_revision: 0,
            projected: Vec::new(),
            capture_error: None,
        };
        // A known launch is never reported as a refusal. Settlement cannot
        // fail for these fixed-size codes; if it ever did, the entry stays
        // pending (lookups report Pending, never permission to relaunch).
        let settlement = self.ledger.settle(ticket, settled, now_ns);
        debug_assert!(settlement.is_ok(), "fixed-size broker outcome must settle");
        Ok(outcome)
    }
}
