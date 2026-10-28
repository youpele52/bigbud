//! Owner-held opaque target/observation references (plan M3 "Observation/
//! session semantics"). A reference binds caller session, policy revision,
//! pause epoch, worker/session generation, verified process lifetime, window,
//! modality, geometry/scale and upstream capture identity. PIDs/window IDs are
//! native hints inside the binding, never public selectors. Resolution refuses
//! expiry, cross-caller use, PID/window reuse, geometry or generation change
//! with the frozen stale/modality codes and an `observe_again` hint; nothing is
//! silently recaptured, and a stale entry is removed (it can never become
//! valid again). Every admitted mutation invalidates ALL observations: one
//! physical lane serves every caller, so any mutation may change any visual
//! assumption. Capacity overflow refuses explicitly, never evicting live
//! authority; entries issued under superseded authority are reclaimed.
//! Discovery selection handles (D-run3-2) live in `references.selection.rs`.
//! Dormant model: not wired to dispatch.
use super::limits::{
    MAX_OBSERVATION_BYTES, MAX_OBSERVATIONS, MAX_TARGET_REFS_PER_CALLER, OBSERVATION_TTL,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Modality {
    Pixel,
    Accessibility,
}

/// Verified OS identity of the target at binding/resolution time.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Identity {
    pub pid: u32,
    /// Process start identity (PID reuse changes it).
    pub process_start: String,
    pub window: u64,
    /// x, y, width, height and scale (thousandths).
    pub geometry: (i64, i64, u64, u64, u32),
}

/// Authority facts the reference was issued under.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Epochs {
    pub policy_revision: u64,
    pub pause_epoch: u64,
    pub worker_generation: String,
    pub session_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Binding {
    pub caller: String,
    pub epochs: Epochs,
    pub identity: Identity,
    pub modality: Modality,
    pub capture_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefRefusal {
    TargetMissing,
    TargetStale,
    ObservationMissing,
    ObservationStale,
    ModalityMismatch,
    TargetCapacity,
    ObservationCapacity,
}
impl RefRefusal {
    /// Frozen public v2 error code.
    pub fn code(self) -> &'static str {
        match self {
            Self::TargetMissing => "target_missing",
            Self::TargetStale => "target_stale",
            Self::ObservationMissing => "observation_missing",
            Self::ObservationStale => "observation_stale",
            Self::ModalityMismatch => "modality_mismatch",
            Self::TargetCapacity | Self::ObservationCapacity => "queue_full",
        }
    }
    /// Stale/modality refusals tell the agent to observe again.
    pub fn observe_again(self) -> bool {
        matches!(
            self,
            Self::TargetStale | Self::ObservationStale | Self::ModalityMismatch
        )
    }
}

struct Entry {
    binding: Binding,
    expires_ns: u64,
    bytes: usize,
}

pub struct References {
    next: u64,
    targets: BTreeMap<String, Entry>,
    /// Short-lived discovery handles; never counted against the target cap.
    selections: BTreeMap<String, Entry>,
    observations: BTreeMap<String, Entry>,
    observation_bytes: usize,
    /// Current worker generation, set only by the owner (`new` for the first
    /// worker, `rotate_worker` on every replacement). Worker generations are
    /// opaque (unordered): issuance under any other generation is refused,
    /// never adopted and never evicting.
    worker: String,
}

fn ttl_ns() -> u64 {
    u64::try_from(OBSERVATION_TTL.as_nanos()).unwrap_or(u64::MAX)
}

impl References {
    /// An empty table for the owner's first worker generation.
    pub fn new(worker_generation: &str) -> Self {
        Self {
            next: 0,
            targets: BTreeMap::new(),
            selections: BTreeMap::new(),
            observations: BTreeMap::new(),
            observation_bytes: 0,
            worker: worker_generation.to_owned(),
        }
    }

    fn mint(&mut self, prefix: char) -> Option<String> {
        self.next = self.next.checked_add(1)?;
        Some(format!("{prefix}{}", self.next))
    }

    fn drop_where(&mut self, gone: impl Fn(&Entry) -> bool) {
        self.targets.retain(|_, entry| !gone(entry));
        self.selections.retain(|_, entry| !gone(entry));
        let mut freed = 0_usize;
        self.observations.retain(|_, entry| {
            let drop = gone(entry);
            if drop {
                freed = freed.saturating_add(entry.bytes);
            }
            !drop
        });
        self.observation_bytes = self.observation_bytes.saturating_sub(freed);
    }

    /// Drops expired entries, reclaiming capacity (never live authority).
    pub fn expire(&mut self, now_ns: u64) {
        self.drop_where(|entry| entry.expires_ns <= now_ns);
    }

    /// Owner-announced worker replacement: every reference bound to another
    /// worker generation is revoked, and only `generation` may issue.
    pub fn rotate_worker(&mut self, generation: &str) {
        generation.clone_into(&mut self.worker);
        self.drop_where(|entry| entry.binding.epochs.worker_generation != generation);
    }

    /// Reclaims expired entries and those issued under strictly older
    /// authority (policy revision and pause epoch only ever increase), a
    /// different worker generation, or an older session of the same caller.
    /// A binding that is itself older than a live entry (or than the
    /// caller's live session, or not the current worker) is refused: a slow
    /// capture under superseded authority never evicts newer references.
    fn reclaim(
        &mut self,
        (caller, epochs): (&str, &Epochs),
        now_ns: u64,
        stale: RefRefusal,
    ) -> Result<(), RefRefusal> {
        let older = |a: &Epochs, b: &Epochs| {
            a.policy_revision < b.policy_revision || a.pause_epoch < b.pause_epoch
        };
        if self.worker != epochs.worker_generation {
            return Err(stale);
        }
        let superseded = self
            .targets
            .values()
            .chain(self.selections.values())
            .chain(self.observations.values())
            .any(|entry| {
                let live = &entry.binding.epochs;
                entry.expires_ns > now_ns
                    && (older(epochs, live)
                        || (entry.binding.caller == caller
                            && epochs.session_generation < live.session_generation))
            });
        if superseded {
            return Err(stale);
        }
        self.drop_where(|entry| {
            let old = &entry.binding.epochs;
            entry.expires_ns <= now_ns
                || older(old, epochs)
                || old.worker_generation != epochs.worker_generation
                || (entry.binding.caller == caller
                    && old.session_generation != epochs.session_generation)
        });
        Ok(())
    }

    pub fn issue_target(&mut self, binding: Binding, now_ns: u64) -> Result<String, RefRefusal> {
        let authority = (binding.caller.as_str(), &binding.epochs);
        self.reclaim(authority, now_ns, RefRefusal::TargetStale)?;
        let held = self
            .targets
            .values()
            .filter(|entry| entry.binding.caller == binding.caller)
            .count();
        if held >= MAX_TARGET_REFS_PER_CALLER {
            return Err(RefRefusal::TargetCapacity);
        }
        let id = self.mint('t').ok_or(RefRefusal::TargetCapacity)?;
        let expires_ns = now_ns.saturating_add(ttl_ns());
        let entry = Entry {
            binding,
            expires_ns,
            bytes: 0,
        };
        self.targets.insert(id.clone(), entry);
        Ok(id)
    }

    /// A normal qualified read creates an observation; previews never do.
    pub fn issue_observation(
        &mut self,
        binding: Binding,
        encoded_bytes: usize,
        now_ns: u64,
    ) -> Result<String, RefRefusal> {
        let authority = (binding.caller.as_str(), &binding.epochs);
        self.reclaim(authority, now_ns, RefRefusal::ObservationStale)?;
        let bytes = self
            .observation_bytes
            .checked_add(encoded_bytes)
            .filter(|total| *total <= MAX_OBSERVATION_BYTES);
        let (Some(bytes), true) = (bytes, self.observations.len() < MAX_OBSERVATIONS) else {
            return Err(RefRefusal::ObservationCapacity);
        };
        let id = self.mint('o').ok_or(RefRefusal::ObservationCapacity)?;
        let expires_ns = now_ns.saturating_add(ttl_ns());
        let entry = Entry {
            binding,
            expires_ns,
            bytes: encoded_bytes,
        };
        self.observations.insert(id.clone(), entry);
        self.observation_bytes = bytes;
        Ok(id)
    }

    fn check(
        entry: Option<&Entry>,
        caller: &str,
        epochs: &Epochs,
        live: &Identity,
        modality: Modality,
        now_ns: u64,
        (missing, stale): (RefRefusal, RefRefusal),
    ) -> Result<(), RefRefusal> {
        // Another caller's reference is indistinguishable from absent.
        let entry = entry
            .filter(|entry| entry.binding.caller == caller)
            .ok_or(missing)?;
        if entry.expires_ns <= now_ns
            || entry.binding.epochs != *epochs
            || entry.binding.identity != *live
        {
            return Err(stale);
        }
        if entry.binding.modality != modality {
            return Err(RefRefusal::ModalityMismatch);
        }
        Ok(())
    }

    /// Revalidates a target against current authority and live OS identity.
    /// A stale target is removed so it can never resolve again. A discovery
    /// selection handle is promoted into the counted target set on first use.
    pub fn resolve_target(
        &mut self,
        id: &str,
        caller: &str,
        epochs: &Epochs,
        live: &Identity,
        modality: Modality,
        now_ns: u64,
    ) -> Result<&Binding, RefRefusal> {
        if self.selections.contains_key(id) {
            self.promote_selection(id, caller, epochs, live, modality, now_ns)?;
        }
        let pair = (RefRefusal::TargetMissing, RefRefusal::TargetStale);
        let checked = Self::check(
            self.targets.get(id),
            caller,
            epochs,
            live,
            modality,
            now_ns,
            pair,
        );
        if checked == Err(RefRefusal::TargetStale) {
            self.targets.remove(id);
        }
        checked?;
        self.targets
            .get(id)
            .map(|entry| &entry.binding)
            .ok_or(RefRefusal::TargetMissing)
    }

    /// Admission of ANY mutation. A click/drag (or coordinate scroll) names
    /// its pixel observation, which must match and is consumed; on success
    /// every other observation of every caller is invalidated too. A refused
    /// mutation changes nothing except removing a stale named observation.
    pub fn admit_mutation(
        &mut self,
        observation: Option<&str>,
        caller: &str,
        epochs: &Epochs,
        live: &Identity,
        now_ns: u64,
    ) -> Result<Option<Binding>, RefRefusal> {
        let consumed = match observation {
            Some(id) => {
                let pair = (RefRefusal::ObservationMissing, RefRefusal::ObservationStale);
                let entry = self.observations.get(id);
                let checked =
                    Self::check(entry, caller, epochs, live, Modality::Pixel, now_ns, pair);
                if checked == Err(RefRefusal::ObservationStale) {
                    self.drop_observation(id);
                }
                checked?;
                self.observations.get(id).map(|entry| entry.binding.clone())
            }
            None => None,
        };
        self.observations.clear();
        self.observation_bytes = 0;
        Ok(consumed)
    }

    fn drop_observation(&mut self, id: &str) {
        if let Some(entry) = self.observations.remove(id) {
            self.observation_bytes = self.observation_bytes.saturating_sub(entry.bytes);
        }
    }

    /// End/cancel/provider replacement revokes every reference of the caller.
    pub fn release_caller(&mut self, caller: &str) {
        self.drop_where(|entry| entry.binding.caller == caller);
    }
}

#[path = "references.selection.rs"]
mod selection;
pub use selection::DiscoveredWindow;
