//! Discovery selection handles (decision D-run3-2). `list_windows` and
//! filtered accessibility discovery return a caller-bound `targetRef` for
//! every permitted window. Those references are selection handles, not
//! admission grants: they are short-lived, sit outside the four retained
//! target references per caller, and are promoted into that counted set on
//! first use (keeping the same opaque ID) after exact revalidation. A full
//! retained set refuses promotion explicitly and never evicts live authority.
//! Repeated discovery of an unchanged window returns the same handle, so
//! polling does not grow the table; a window rediscovered with a changed
//! binding (geometry, scale, capture) replaces its unpromoted handle.
//! Dormant model: not wired to dispatch.
use super::super::limits::{
    MAX_CALLER_SESSIONS, MAX_SELECTION_HANDLES_PER_CALLER, SELECTION_HANDLE_TTL,
};
use super::{
    Binding, Epochs, Identity, MAX_TARGET_REFS_PER_CALLER, Modality, RefRefusal, References, ttl_ns,
};
use std::collections::{HashMap, HashSet};

/// One permitted window as rebuilt from discovery output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredWindow {
    pub identity: Identity,
    pub modality: Modality,
    pub capture_id: Option<String>,
}

fn selection_ttl_ns() -> u64 {
    u64::try_from(SELECTION_HANDLE_TTL.as_nanos()).unwrap_or(u64::MAX)
}

/// A window as the agent sees it; a changed binding under the same key
/// proves the older handle stale.
type WindowKey<'a> = (u32, &'a str, u64, Modality);
fn window_key(binding: &Binding) -> WindowKey<'_> {
    let identity = &binding.identity;
    (
        identity.pid,
        identity.process_start.as_str(),
        identity.window,
        binding.modality,
    )
}

impl References {
    /// Issues one handle per discovered window, all-or-nothing: discovery
    /// under superseded authority or beyond the per-caller (or table-wide)
    /// selection bound refuses without changing any live reference. The
    /// discovery proves each matched binding live, so its handle (selection
    /// or already-promoted target) is kept for at least a selection TTL.
    pub fn issue_selections(
        &mut self,
        caller: &str,
        epochs: &Epochs,
        windows: Vec<DiscoveredWindow>,
        now_ns: u64,
    ) -> Result<Vec<String>, RefRefusal> {
        let bindings: Vec<Binding> = windows
            .into_iter()
            .map(|window| Binding {
                caller: caller.to_owned(),
                epochs: epochs.clone(),
                identity: window.identity,
                modality: window.modality,
                capture_id: window.capture_id,
            })
            .collect();
        let unique: HashSet<&Binding> = bindings.iter().collect();
        if unique.len() > MAX_SELECTION_HANDLES_PER_CALLER {
            return Err(RefRefusal::TargetCapacity);
        }
        self.reclaim((caller, epochs), now_ns, RefRefusal::TargetStale)?;
        // One pass over the tables; retained targets take precedence.
        let mut known: HashMap<Binding, String> = HashMap::new();
        let mut held = 0_usize;
        for (id, entry) in &self.selections {
            if entry.binding.caller == caller {
                held = held.saturating_add(1);
                known.insert(entry.binding.clone(), id.clone());
            }
        }
        for (id, entry) in &self.targets {
            if entry.binding.caller == caller {
                known.insert(entry.binding.clone(), id.clone());
            }
        }
        let fresh = unique.iter().filter(|b| !known.contains_key(**b)).count();
        let keys: HashSet<WindowKey<'_>> = unique.iter().map(|b| window_key(b)).collect();
        let replaced: Vec<String> = self
            .selections
            .iter()
            .filter(|(_, entry)| {
                entry.binding.caller == caller
                    && keys.contains(&window_key(&entry.binding))
                    && !unique.contains(&entry.binding)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let after = |count: usize| {
            count
                .checked_sub(replaced.len())
                .and_then(|kept| kept.checked_add(fresh))
        };
        let table_bound = MAX_CALLER_SESSIONS.saturating_mul(MAX_SELECTION_HANDLES_PER_CALLER);
        let fits = after(held).is_some_and(|count| count <= MAX_SELECTION_HANDLES_PER_CALLER)
            && after(self.selections.len()).is_some_and(|count| count <= table_bound);
        let mintable = u64::try_from(fresh)
            .ok()
            .and_then(|count| self.next.checked_add(count))
            .is_some();
        if !fits || !mintable {
            return Err(RefRefusal::TargetCapacity);
        }
        for id in &replaced {
            self.selections.remove(id);
        }
        let expires_ns = now_ns.saturating_add(selection_ttl_ns());
        let mut ids = Vec::with_capacity(bindings.len());
        for binding in bindings {
            let id = match known.get(&binding) {
                Some(id) => id.clone(),
                None => {
                    let id = self.mint('t').ok_or(RefRefusal::TargetCapacity)?;
                    known.insert(binding.clone(), id.clone());
                    let entry = super::Entry {
                        binding,
                        expires_ns,
                        bytes: 0,
                    };
                    self.selections.insert(id.clone(), entry);
                    id
                }
            };
            let entry = match self.selections.get_mut(&id) {
                Some(entry) => Some(entry),
                None => self.targets.get_mut(&id),
            };
            if let Some(entry) = entry {
                entry.expires_ns = entry.expires_ns.max(expires_ns);
            }
            ids.push(id);
        }
        Ok(ids)
    }

    /// Revalidates a selection exactly like a target and moves it, under the
    /// same ID, into the counted retained set with the target TTL. Capacity
    /// is counted after the same reclamation `issue_target` performs, so
    /// expired or superseded targets never block promotion. A stale
    /// selection is removed; a full retained set leaves it untouched.
    pub(super) fn promote_selection(
        &mut self,
        id: &str,
        caller: &str,
        epochs: &Epochs,
        live: &Identity,
        modality: Modality,
        now_ns: u64,
    ) -> Result<(), RefRefusal> {
        let pair = (RefRefusal::TargetMissing, RefRefusal::TargetStale);
        let entry = self.selections.get(id);
        let checked = Self::check(entry, caller, epochs, live, modality, now_ns, pair)
            .and_then(|()| self.reclaim((caller, epochs), now_ns, RefRefusal::TargetStale));
        if checked == Err(RefRefusal::TargetStale) {
            self.selections.remove(id);
        }
        checked?;
        let targets = self
            .targets
            .values()
            .filter(|entry| entry.binding.caller == caller)
            .count();
        if targets >= MAX_TARGET_REFS_PER_CALLER {
            return Err(RefRefusal::TargetCapacity);
        }
        let mut entry = self
            .selections
            .remove(id)
            .ok_or(RefRefusal::TargetMissing)?;
        entry.expires_ns = now_ns.saturating_add(ttl_ns());
        self.targets.insert(id.to_owned(), entry);
        Ok(())
    }
}
