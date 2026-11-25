//! Resolved-target cache and the active-binding slot (W3.7).
//!
//! Resolution is pure filesystem/config work: the first descriptor for a target
//! validates and caches its transport, later requests must match the descriptor
//! digest and generation, and the one pinned fixture target is cached the same
//! way. No socket is opened here.

use super::super::reconnect::ReconnectAdmission;
use super::super::{RunResult, Token};
use super::{Descriptor, Lanes, MAX_TARGETS, TargetAuthority};
use crate::owner_storage::Storage;
use crate::{
    config::RouteFacts,
    owner_trust::TrustApproval,
    random_token,
    transport::Transport,
    v1::{self, ErrorCode},
};
use std::collections::HashMap;

/// The live state of one resolved target. The active target's fields are moved
/// into `Owner` for the duration of a request, so every existing dispatch path
/// observes the exact target its request named.
pub(crate) struct Slot {
    pub(crate) target: String,
    pub(crate) generation: Token,
    pub(crate) transport: Option<Transport>,
    pub(crate) storage: Option<Storage>,
    pub(crate) trust: TrustApproval,
    pub(crate) reconnect: ReconnectAdmission,
    /// Masters, PTY, agent proxy and OpenCode leases owned by this target.
    pub(crate) lanes: Lanes,
}

impl Slot {
    pub(crate) fn into_fields(
        self,
    ) -> (
        String,
        Token,
        Option<Transport>,
        Storage,
        TrustApproval,
        ReconnectAdmission,
        Lanes,
    ) {
        (
            self.target,
            self.generation,
            self.transport,
            self.storage.unwrap_or_else(Storage::unhydrated),
            self.trust,
            self.reconnect,
            self.lanes,
        )
    }
}

/// Resolution of one requested target, before any grant is issued.
pub(crate) struct Preview {
    pub(crate) target_id: String,
}

/// Every target this owner epoch has resolved, plus the one pinned fixture
/// target. The pinned id is the only target addressable without a descriptor.
#[derive(Default)]
pub(crate) struct Registry {
    pinned: Option<String>,
    /// Descriptor digest per resolved target. Kept outside the live slot so a
    /// target keeps its identity while its fields are swapped in and out.
    digests: HashMap<String, [u8; 32]>,
    entries: HashMap<String, Slot>,
    suspended: Option<Slot>,
}

impl Registry {
    pub(crate) fn with_pinned(
        target: String,
        generation: Token,
        transport: Transport,
        storage: Storage,
        lanes: Lanes,
    ) -> Self {
        let mut entries = HashMap::new();
        entries.insert(
            target.clone(),
            Slot {
                target: target.clone(),
                generation,
                transport: Some(transport),
                storage: Some(storage),
                trust: TrustApproval::default(),
                reconnect: ReconnectAdmission::default(),
                lanes,
            },
        );
        Self {
            pinned: Some(target),
            digests: HashMap::new(),
            entries,
            suspended: None,
        }
    }

    pub(crate) fn pinned(&self) -> Option<&str> {
        self.pinned.as_deref()
    }

    /// Resolves a target for grant issuance. A new descriptor is validated and
    /// cached here; an existing one must match its descriptor digest and the
    /// caller's generation exactly.
    pub(crate) fn resolve(
        &mut self,
        authority: Option<&TargetAuthority>,
        request: &v1::Request,
        bound: Option<(&str, Token)>,
    ) -> Result<Preview, ErrorCode> {
        let Some(wire) = request.target_descriptor.as_ref() else {
            let Some(pinned) = self.pinned.clone() else {
                return Err(ErrorCode::TargetUnknown);
            };
            if request.target_id != pinned {
                return Err(ErrorCode::TargetUnknown);
            }
            // The pinned target is either bound to the owner's flat fields or
            // cached while another target is bound. Both carry its generation.
            let current = match self.entries.get(&pinned) {
                Some(entry) => entry.generation,
                None => match bound {
                    Some((target, generation)) if target == pinned => generation,
                    _ => return Err(ErrorCode::TargetUnknown),
                },
            };
            if request.target_generation != current {
                return Err(ErrorCode::StaleGeneration);
            }
            return Ok(Preview { target_id: pinned });
        };
        let descriptor = Descriptor::parse(wire)?;
        if bound.is_some_and(|(target, _)| target == descriptor.target_id)
            && !self.entries.contains_key(&descriptor.target_id)
        {
            // The pinned target has no descriptor digest to compare against.
            return Err(ErrorCode::TargetMismatch);
        }
        if descriptor.target_id != request.target_id
            || descriptor.generation() != request.target_generation.as_slice()
        {
            return Err(ErrorCode::InvalidOperands);
        }
        if let Some(entry) = self.entries.get(&descriptor.target_id) {
            if self.digests.get(&descriptor.target_id) != Some(&descriptor.digest()) {
                return Err(ErrorCode::TargetMismatch);
            }
            if request.target_generation != entry.generation {
                return Err(ErrorCode::StaleGeneration);
            }
            // Re-validate the alias descriptor and the owner-side trust inputs on
            // every resolution, per target. A changed policy invalidates only
            // this target's cached transport, snapshot and live lanes.
            if let Some(authority) = authority {
                let verified = authority.bind(&descriptor);
                if let Some(entry) = self.entries.get_mut(&descriptor.target_id) {
                    match verified {
                        Ok(config) => {
                            if entry.transport.is_none() {
                                let transport = Transport::new_with_facts(
                                    config,
                                    &RouteFacts::default().with_production(),
                                )
                                .map_err(|_| ErrorCode::ConfigUnsupported)?;
                                entry.transport = Some(transport);
                                entry.storage = None;
                            }
                        }
                        Err(error) => {
                            entry.transport = None;
                            entry.storage = None;
                            entry.trust = TrustApproval::default();
                            entry.reconnect = ReconnectAdmission::default();
                            entry.lanes.invalidate_transport();
                            return Err(error);
                        }
                    }
                }
            }
            return Ok(Preview {
                target_id: descriptor.target_id.clone(),
            });
        }
        if !request.target_generation.is_empty() {
            // A generation is only meaningful for a target this epoch resolved.
            return Err(ErrorCode::StaleGeneration);
        }
        if self.entries.len() >= MAX_TARGETS {
            return Err(ErrorCode::OwnerUnavailable);
        }
        let authority = authority.ok_or(ErrorCode::ConfigUnsupported)?;
        let transport = Transport::new_with_facts(
            authority.bind(&descriptor)?,
            &RouteFacts::default().with_production(),
        )
        .map_err(|_| ErrorCode::ConfigUnsupported)?;
        let generation = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let target_id = descriptor.target_id.clone();
        self.entries.insert(
            target_id.clone(),
            Slot {
                target: target_id.clone(),
                generation,
                transport: Some(transport),
                storage: None,
                trust: TrustApproval::default(),
                reconnect: ReconnectAdmission::default(),
                lanes: Lanes::default(),
            },
        );
        self.digests.insert(target_id.clone(), descriptor.digest());
        Ok(Preview { target_id })
    }

    /// Fixture parity: the pinned target keeps its startup storage available
    /// before the first request, as the single-target owner did.
    pub(crate) fn storage_available(&self, target_id: &str) -> Result<(), ErrorCode> {
        match self
            .entries
            .get(target_id)
            .and_then(|entry| entry.storage.as_ref())
        {
            Some(storage) => storage.available(),
            None => Ok(()),
        }
    }

    /// Hydrates the target's durable state through the authenticated pipe on
    /// first network use. Fixture mode hydrates at bootstrap and is unchanged.
    pub(crate) fn ensure_storage(
        &mut self,
        pipe: &mut impl crate::owner_pipe::PayloadPipe,
        target_id: &str,
    ) -> RunResult<Result<(), ErrorCode>> {
        let Some(entry) = self.entries.get_mut(target_id) else {
            return Ok(Err(ErrorCode::TargetUnknown));
        };
        if entry.storage.is_some() {
            return Ok(Ok(()));
        }
        let storage = Storage::hydrate(pipe, target_id)?;
        entry.storage = Some(storage);
        Ok(Ok(()))
    }

    pub(crate) fn generation(&self, target_id: &str) -> Option<Token> {
        self.entries.get(target_id).map(|entry| entry.generation)
    }

    /// The exact target's live lanes, or none for an unknown target. The pinned
    /// fixture target lives in the owner fields, not here, while it is bound.
    pub(crate) fn lanes(&self, target_id: &str) -> Option<&Lanes> {
        self.entries.get(target_id).map(|entry| &entry.lanes)
    }

    /// Confirmed teardown of every cached target's live leases. The target
    /// identity, generation and snapshot stay, so a later request re-resolves
    /// the same target instead of being told its generation is stale.
    pub(crate) fn revoke_cached_lanes(&mut self) -> Result<(), ErrorCode> {
        let mut result = Ok(());
        for entry in self.entries.values_mut() {
            if entry.transport.is_some() {
                result = result.and(entry.lanes.revoke());
            }
        }
        result
    }

    /// True when any cached target has an ambiguous lease outcome, so a writer
    /// handoff must fence every target before acknowledging the new binding.
    pub(crate) fn has_uncertain_lanes(&self) -> bool {
        self.entries
            .values()
            .any(|entry| entry.lanes.terminal_uncertain || entry.lanes.agent_close_uncertain)
    }

    /// A detached session cannot hand its 20-second reservation token to the
    /// next attached client.
    pub(crate) fn clear_preparations(&mut self) {
        for entry in self.entries.values_mut() {
            entry.lanes.preparation = None;
        }
    }

    /// Moves one target out of the cache so its fields can become the active
    /// binding. The caller must restore it (or its successor) afterwards.
    pub(crate) fn take(&mut self, target_id: &str) -> Result<Slot, ErrorCode> {
        self.entries
            .remove(target_id)
            .ok_or(ErrorCode::TargetUnknown)
    }

    pub(crate) fn suspend(&mut self, slot: Slot) {
        self.suspended = Some(slot);
    }

    pub(crate) fn take_suspended(&mut self) -> Option<Slot> {
        self.suspended.take()
    }

    /// Caches a finished target. A slot without a transport is the at-rest
    /// production state and is not addressable.
    pub(crate) fn restore(&mut self, slot: Slot) {
        if slot.transport.is_some() {
            self.entries.insert(slot.target.clone(), slot);
        }
    }

    /// A backend rebind invalidates every cached sequence/disconnect snapshot;
    /// each target re-hydrates on its next admitted request.
    pub(crate) fn invalidate_storage(&mut self) {
        for entry in self.entries.values_mut() {
            entry.storage = None;
        }
    }
}
