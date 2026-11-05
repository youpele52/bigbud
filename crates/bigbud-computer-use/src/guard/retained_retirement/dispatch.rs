use crate::worker::{
    ExecutionRoot,
    unix::{AnchoredGroup, ClosureState, RetirementSignal},
};
use std::{io, sync::Mutex};

const ESCALATE_NS: u64 = 250_000_000;
const UNKNOWN_NS: u64 = 2_000_000_000;

/// Signal acknowledgement is never physical settlement. Unknown is sticky on
/// any clock/signal error or the hard deadline. Roots are never removed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RetirementStatus {
    pub requested: bool,
    pub causes: u8,
    pub term_sent: u8,
    pub kill_sent: u8,
    /// Exact roots whose known closure settled and whose leader was reaped.
    pub settled: u8,
    pub unknown: bool,
}

pub(super) enum Target {
    Owned(AnchoredGroup),
    /// Reaped tombstone: keeps index/root only, never signal authority.
    Settled(ExecutionRoot),
    #[cfg(test)]
    Fixture(super::tests::Fixture),
}
impl Target {
    pub(super) fn root(&self) -> &ExecutionRoot {
        match self {
            Self::Owned(anchor) => anchor.root(),
            Self::Settled(root) => root,
            #[cfg(test)]
            Self::Fixture(fixture) => &fixture.root,
        }
    }
    fn signal(&mut self, signal: RetirementSignal) -> io::Result<()> {
        match self {
            Self::Owned(anchor) => anchor.signal(signal),
            Self::Settled(_) => Err(io::Error::other("settled root has no group")),
            #[cfg(test)]
            Self::Fixture(fixture) => fixture.signal(signal),
        }
    }
    fn closure(&self) -> io::Result<ClosureState> {
        match self {
            Self::Owned(anchor) => anchor.closure(),
            Self::Settled(_) => Ok(ClosureState::Settled),
            #[cfg(test)]
            Self::Fixture(fixture) => fixture.closure(),
        }
    }
    /// Replaces an owner with its tombstone ONLY after the owner reaped itself
    /// on a fresh Settled observation; refusal restores the same owner.
    fn settle(&mut self) -> io::Result<ExecutionRoot> {
        let root = self.root().clone();
        match std::mem::replace(self, Self::Settled(root.clone())) {
            Self::Owned(anchor) => match anchor.settle() {
                Ok(settled) => Ok(settled.root().clone()),
                Err(refused) => {
                    let refused = *refused;
                    *self = Self::Owned(refused.anchor);
                    Err(refused.error)
                }
            },
            Self::Settled(_) => Err(io::Error::other("already settled")),
            #[cfg(test)]
            Self::Fixture(fixture) => match fixture.settle() {
                Ok(()) => Ok(root),
                Err(error) => {
                    *self = Self::Fixture(fixture);
                    Err(error)
                }
            },
        }
    }
}

pub(in crate::guard::retained_recovery) struct OwnedRetirement {
    pub(super) targets: Vec<Target>,
    pub(super) status: RetirementStatus,
    first_ns: Option<u64>,
    last_ns: Option<u64>,
}
impl OwnedRetirement {
    pub(super) fn new(targets: Vec<Target>) -> Self {
        Self {
            targets,
            status: RetirementStatus::default(),
            first_ns: None,
            last_ns: None,
        }
    }

    pub(super) fn all_settled(&self) -> bool {
        let count = u32::try_from(self.targets.len()).unwrap_or(u32::MAX);
        let mask = 1_u16.checked_shl(count).map_or(u16::MAX, |bit| bit - 1);
        u16::from(self.status.settled) == mask
    }

    /// Observation never signals. A Settled closure is reaped by its sole owner
    /// and reported once through the bounded (<=8) handoff to the storage lane.
    /// Observation errors are not settlement; a failed reap is sticky unknown.
    pub(super) fn observe_settlement(&mut self, handoff: &Mutex<Vec<ExecutionRoot>>) {
        for (index, target) in self.targets.iter_mut().enumerate() {
            let bit = 1_u8 << index;
            if self.status.settled & bit != 0 {
                continue;
            }
            match target.closure() {
                Ok(ClosureState::Settled) => {}
                Ok(_) => continue,
                // ECHILD (foreign reap), missing pinned leader or an
                // unavailable enumerator: closure can never be confirmed.
                Err(_) => {
                    self.status.unknown = true;
                    continue;
                }
            }
            match target.settle() {
                Ok(root) => {
                    self.status.settled |= bit;
                    // A poisoned handoff still holds a consistent Vec.
                    handoff
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(root);
                }
                Err(_) => self.status.unknown = true,
            }
        }
    }

    /// Time until the next escalation (KILL) or unknown deadline, for
    /// deadline-aware parking; None when nothing is pending.
    pub(super) fn next_deadline_ns(&self, now: u64) -> Option<u64> {
        let first = self.first_ns?;
        if !self.status.requested || self.status.unknown || self.all_settled() {
            return None;
        }
        let elapsed = now.saturating_sub(first);
        let deadline = if elapsed < ESCALATE_NS {
            ESCALATE_NS
        } else {
            UNKNOWN_NS
        };
        Some(deadline.saturating_sub(elapsed))
    }

    /// One bounded pass over <=8 owned anchors, never wait/sleep/reap/observe
    /// leader exit. Even late service attempts outstanding TERM and KILL before
    /// returning unknown. Repeated requests cannot replace the original anchor.
    pub(super) fn step(&mut self, causes: u8, pending_session: bool, now: io::Result<u64>) {
        self.status.causes |= causes;
        self.status.requested |= causes != 0 || pending_session;
        if !self.status.requested {
            return;
        }
        let elapsed = match now {
            Ok(now) if self.last_ns.is_none_or(|last| now >= last) => {
                self.last_ns = Some(now);
                let first = *self.first_ns.get_or_insert(now);
                now.checked_sub(first)
            }
            _ => {
                self.status.unknown = true;
                None
            }
        };
        // A failed initial clock cannot prevent TERM. A later valid sample is
        // only a conservative lower bound; never invent >=250ms elapsed proof.
        for (index, target) in self.targets.iter_mut().enumerate() {
            let bit = 1_u8 << index;
            if self.status.settled & bit != 0 {
                continue;
            }
            if self.status.term_sent & bit == 0 {
                match target.signal(RetirementSignal::Terminate) {
                    Ok(()) => self.status.term_sent |= bit,
                    Err(_) => self.status.unknown = true,
                }
            }
            if elapsed.is_some_and(|ns| ns >= ESCALATE_NS) && self.status.kill_sent & bit == 0 {
                match target.signal(RetirementSignal::Kill) {
                    Ok(()) => self.status.kill_sent |= bit,
                    Err(_) => self.status.unknown = true,
                }
            }
        }
        // Confirmed settlement within the deadline is not later made unknown.
        let unsettled = !self.all_settled();
        self.status.unknown |= unsettled && elapsed.is_some_and(|ns| ns >= UNKNOWN_NS);
    }
}
