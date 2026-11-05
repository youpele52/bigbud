use crate::guard::{Journal, JournalError, record::SafetyRecord};
use crate::worker::{ExecutionRoot, Observation, RetirementDecision, retirement_decision};

pub trait SafetySink {
    type Error;
    fn persist(&mut self, record: &SafetyRecord) -> Result<(), Self::Error>;
}
impl SafetySink for Journal<'_> {
    type Error = JournalError;
    fn persist(&mut self, record: &SafetyRecord) -> Result<(), Self::Error> {
        self.replace(record)
    }
}
#[derive(Debug)]
pub enum FenceError<E> {
    Invalid,
    Unsettled,
    Persistence(E),
}

pub struct GuardFence<S: SafetySink> {
    record: SafetyRecord,
    sink: S,
    persistence_failed: bool,
}
impl<S: SafetySink> GuardFence<S> {
    pub fn from_recovered(record: SafetyRecord, sink: S) -> Result<Self, FenceError<S::Error>> {
        if !record.valid() {
            return Err(FenceError::Invalid);
        }
        Ok(Self {
            record,
            sink,
            persistence_failed: false,
        })
    }
    pub fn record(&self) -> &SafetyRecord {
        &self.record
    }
    pub fn persistence_failed(&self) -> bool {
        self.persistence_failed
    }
    pub(super) fn persist(&mut self) -> Result<(), FenceError<S::Error>> {
        // Even if storage fails, in-memory revocation remains in force. Only a
        // successfully acknowledged complete system may ever open admission.
        self.persistence_failed = true;
        self.sink
            .persist(&self.record)
            .map_err(FenceError::Persistence)?;
        self.persistence_failed = false;
        Ok(())
    }
    pub(super) fn latch(&mut self) {
        self.record.latched = true;
        if self.record.armed {
            self.record.input_uncertain = true;
        }
    }
    pub fn revoke(&mut self, reason: &str) -> Result<u64, FenceError<S::Error>> {
        // Latch BEFORE any fallible epoch arithmetic, validation or disk I/O.
        self.latch();
        let Some(epoch) = self.record.pause_epoch.checked_add(1) else {
            self.record.reason = "epoch_exhausted".into();
            self.persist()?;
            return Err(FenceError::Invalid);
        };
        self.record.pause_epoch = epoch;
        if !crate::guard::record::valid_id(reason) {
            self.record.reason = "invalid_revocation".into();
            self.persist()?;
            return Err(FenceError::Invalid);
        }
        self.record.reason = reason.into();
        self.persist()?;
        Ok(self.record.pause_epoch)
    }
    /// Record exact roots before execution admission. A frozen bootstrap child
    /// may already exist to obtain its native creation identity, but must not
    /// start Driver work. This is NOT permission to execute or open admission.
    pub fn record_execution_roots(
        &mut self,
        roots: Vec<ExecutionRoot>,
    ) -> Result<(), FenceError<S::Error>> {
        if !self.record.roots.is_empty() {
            return Err(FenceError::Unsettled);
        }
        if roots.is_empty() {
            return Err(FenceError::Invalid);
        }
        let mut next = self.record.clone();
        next.roots = roots;
        next.armed = true;
        if !next.valid() {
            return Err(FenceError::Invalid);
        }
        self.record = next;
        self.persist()
    }
    /// Removes ONLY exact recorded roots proven settled by their sole owner.
    /// Pause, armed and input uncertainty are unchanged; an unknown root
    /// rejects the whole batch before mutation.
    // Only the macOS retained recovery consumes this until other guards exist.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn settle_roots(
        &mut self,
        settled: &[ExecutionRoot],
    ) -> Result<usize, FenceError<S::Error>> {
        if settled.is_empty() || !settled.iter().all(|root| self.record.roots.contains(root)) {
            return Err(FenceError::Invalid);
        }
        let mut next = self.record.clone();
        next.roots.retain(|root| !settled.contains(root));
        // Clear the active marker only after clean retirement with no latch.
        if next.roots.is_empty() && !next.latched && !next.input_uncertain {
            next.armed = false;
        }
        if !next.valid() {
            return Err(FenceError::Invalid);
        }
        self.record = next;
        self.persist()?;
        Ok(self.record.roots.len())
    }
    pub fn observe_retirement(
        &mut self,
        expected_roots: &[ExecutionRoot],
        observations: &[Observation],
    ) -> Result<usize, FenceError<S::Error>> {
        // A delayed probe of an older root set cannot retire replacements just
        // because its result has the same length. Validate the whole snapshot
        // before applying any proof; the native reader must still be qualified.
        if expected_roots != self.record.roots || observations.len() != expected_roots.len() {
            return Err(FenceError::Invalid);
        }
        self.record.roots = self
            .record
            .roots
            .iter()
            .zip(observations)
            .filter(|(root, observation)| {
                retirement_decision(root, observation) != RetirementDecision::RecordedLifetimeEnded
            })
            .map(|(root, _)| root.clone())
            .collect();
        // Physical retirement does not clear pause, armed or input uncertainty.
        self.persist()?;
        Ok(self.record.roots.len())
    }
}

#[path = "fence.transitions.rs"]
mod transitions;
pub use transitions::{
    Acknowledged, ControllerLease, Settlement, TransitionError, TransitionRefusal,
    UNACKNOWLEDGED_REVISION,
};

#[cfg(test)]
#[path = "fence.tests.rs"]
mod tests;
#[cfg(test)]
#[path = "fence.transitions.tests.rs"]
mod transitions_tests;
