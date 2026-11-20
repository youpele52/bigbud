//! Bounded nonce and terminal fences. No eviction can permit accepted-work replay.
use super::identity::{capability_hash, capability_matches};
use super::{Binding, Error, Result, Snapshot, State};
struct Fence {
    snapshot: Snapshot,
    capability: [u8; 32],
}
#[derive(Default)]
pub(super) struct Retained(Vec<Fence>);
impl Retained {
    pub(super) fn full(&self) -> bool {
        self.0.len() >= 64
    }
    pub(super) fn contains(&self, nonce: &str) -> bool {
        self.0.iter().any(|row| row.snapshot.binding.nonce == nonce)
    }
    pub(super) fn read(&self, binding: &Binding, capability: &[u8]) -> Result<Option<Snapshot>> {
        let Some(row) = self
            .0
            .iter()
            .find(|row| row.snapshot.binding.nonce == binding.nonce)
        else {
            return Ok(None);
        };
        if row.snapshot.binding != *binding || !capability_matches(&row.capability, capability) {
            return Err(Error::Refused);
        }
        Ok(Some(row.snapshot.clone()))
    }
    pub(super) fn cancel(&mut self, binding: Binding, capability: &[u8]) -> Result<Snapshot> {
        if let Some(prior) = self.read(&binding, capability)? {
            if prior.state == State::Cancelled {
                return Ok(prior);
            }
            return Err(Error::Occupied);
        }
        if self.full() {
            return Err(Error::Occupied);
        }
        let capability = capability_hash(capability)?;
        let snapshot = Snapshot {
            binding,
            state: State::Cancelled,
            original_child_pid: 0,
            original_controller: None,
            current_controller: None,
            previous_controller: None,
        };
        self.0.push(Fence {
            snapshot: snapshot.clone(),
            capability,
        });
        Ok(snapshot)
    }
    pub(super) fn exited(&mut self, snapshot: Snapshot, capability: [u8; 32]) -> Result<()> {
        if self.full() || self.contains(&snapshot.binding.nonce) {
            return Err(Error::Occupied);
        }
        self.0.push(Fence {
            snapshot,
            capability,
        });
        Ok(())
    }
}

#[cfg(test)]
#[path = "retention.tests.rs"]
mod tests;
