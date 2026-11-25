//! Active-target binding for one request (W3.7).
//!
//! Dispatch is single-threaded and strictly sequential, so the owner keeps at
//! most one target bound to its flat fields. A request for the bound target uses
//! it directly; a request for another resolved target swaps that target in for
//! the duration of the request and swaps it back afterwards. Every existing
//! dispatch path therefore observes exactly the target its request named,
//! without a second transport implementation.

use super::targets::Slot;
use super::{ErrorCode, Owner, Storage};

impl Owner {
    /// Binds the exact resolved target for one request. The caller must call
    /// [`Owner::leave_target`] after dispatch, including on an error result.
    pub(super) fn enter_target(&mut self, target_id: &str) -> Result<(), ErrorCode> {
        if target_id == self.target && self.transport.is_some() {
            return Ok(());
        }
        let slot = self.targets.take(target_id)?;
        if slot.transport.is_none() {
            // An at-rest slot is not addressable; keep the cached identity.
            self.targets.restore(slot);
            return Err(ErrorCode::OwnerUnavailable);
        }
        let Slot {
            target,
            generation,
            transport,
            storage,
            trust,
            reconnect,
        } = slot;
        let Some(transport) = transport else {
            return Err(ErrorCode::OwnerUnavailable);
        };
        let previous = Slot {
            target: std::mem::replace(&mut self.target, target),
            generation: std::mem::replace(&mut self.generation, generation),
            transport: self.transport.replace(transport),
            storage: Some(std::mem::replace(
                &mut self.storage,
                storage.unwrap_or_else(Storage::unhydrated),
            )),
            trust: std::mem::replace(&mut self.trust, trust),
            reconnect: std::mem::replace(&mut self.reconnect, reconnect),
        };
        self.targets.suspend(previous);
        Ok(())
    }

    /// Restores the previously bound target and caches the finished one.
    pub(super) fn leave_target(&mut self) {
        let Some(previous) = self.targets.take_suspended() else {
            return;
        };
        let finished = Slot {
            target: std::mem::replace(&mut self.target, previous.target),
            generation: std::mem::replace(&mut self.generation, previous.generation),
            transport: std::mem::replace(&mut self.transport, previous.transport),
            storage: Some(std::mem::replace(
                &mut self.storage,
                previous.storage.unwrap_or_else(Storage::unhydrated),
            )),
            trust: std::mem::replace(&mut self.trust, previous.trust),
            reconnect: std::mem::replace(&mut self.reconnect, previous.reconnect),
        };
        self.targets.restore(finished);
    }
}
