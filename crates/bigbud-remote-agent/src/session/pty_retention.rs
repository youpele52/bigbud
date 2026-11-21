//! PTY session retention and the explicit workspace-root reference count (plan §8.10).
//!
//! `refs[handle]` counts live PTY sessions plus retained exited sessions that use the root.
//! Creates, file reads and searches run under the session lock or on a cloned root, so an
//! in-flight operation can never observe a removed root. A terminal root (`terminal-root-*`
//! or legacy `terminal-*`) is removed from `workspace_roots` when its count returns to zero;
//! project roots are never removed implicitly. At `MAX_PTY_SESSIONS`, the oldest exited
//! session whose exit was delivered is retired first, then the oldest create failure.

use super::*;

/// Handles that belong to terminals and are released with their last PTY session.
pub(super) fn is_terminal_root(handle: &str) -> bool {
    handle.starts_with("terminal-")
}

impl AgentSession {
    pub(super) fn retain_workspace_ref(&mut self, handle: &str) {
        let count = self.workspace_refs.entry(handle.to_owned()).or_insert(0);
        *count = count.saturating_add(1);
    }

    pub(super) fn release_workspace_ref(&mut self, handle: &str) {
        let Some(count) = self.workspace_refs.get_mut(handle) else {
            return;
        };
        *count = count.saturating_sub(1);
        if *count == 0 {
            self.workspace_refs.remove(handle);
            if is_terminal_root(handle) {
                self.workspace_roots.remove(handle);
            }
        }
    }

    pub(super) fn workspace_ref_count(&self, handle: &str) -> usize {
        self.workspace_refs.get(handle).copied().unwrap_or(0)
    }

    /// Removes a PTY session and releases its workspace root reference.
    pub(super) fn retire_pty_session(&mut self, pty_id: &str) {
        if let Some(session) = self.pty_sessions.remove(pty_id) {
            self.release_workspace_ref(&session.workspace_handle);
        }
    }

    /// Frees one session slot at `MAX_PTY_SESSIONS`; returns false when nothing may be retired.
    pub(super) fn make_room_for_pty(&mut self) -> bool {
        let exited = self
            .pty_sessions
            .iter()
            .filter(|(_, session)| session.handle.child_reaped())
            .filter_map(|(id, session)| session.expires_at.map(|at| (at, id.clone())))
            .min();
        if let Some((_, id)) = exited {
            self.retire_pty_session(&id);
            return true;
        }
        let failure = self
            .pty_create_failures
            .iter()
            .min_by_key(|(_, failure)| failure.created_at)
            .map(|(id, _)| id.clone());
        if let Some(id) = failure {
            self.pty_create_failures.remove(&id);
            return true;
        }
        false
    }

    /// Zero-reference terminal roots left by an open whose create never came; reclaimed when a
    /// new root needs the slot.
    pub(super) fn reclaim_unused_terminal_root(&mut self) -> bool {
        let unused = self
            .workspace_roots
            .keys()
            .find(|handle| is_terminal_root(handle) && self.workspace_ref_count(handle) == 0)
            .cloned();
        match unused {
            Some(handle) => {
                self.workspace_roots.remove(&handle);
                true
            }
            None => false,
        }
    }

    /// Test and diagnostics view of the reference count.
    #[cfg(test)]
    pub(crate) fn workspace_root_count(&self) -> usize {
        self.workspace_roots.len()
    }
}
