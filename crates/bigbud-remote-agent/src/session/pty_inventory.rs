use sha2::{Digest, Sha256};

use super::*;

impl AgentSession {
    // Read-only: inventory neither launches nor prunes resources. Absence is not exit proof.
    pub(super) fn handle_pty_list(&self, request: v1::PtyListRequest) -> v1::Frame {
        let result = self.pty_inventory_page(&request);
        let response = match result {
            Ok((entries, next_after_pty_id, snapshot_id)) => v1::PtyListResponse {
                request_id: request.request_id,
                agent_epoch: self.agent_epoch.clone(),
                entries,
                next_after_pty_id,
                snapshot_id,
                accepted: true,
                error_code: String::new(),
            },
            Err(code) => v1::PtyListResponse {
                request_id: request.request_id,
                agent_epoch: self.agent_epoch.clone(),
                error_code: code.to_owned(),
                ..Default::default()
            },
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::PtyListResponse(response)),
        }
    }

    fn pty_inventory_page(
        &self,
        request: &v1::PtyListRequest,
    ) -> Result<(Vec<v1::PtyInventoryEntry>, String, String), &'static str> {
        if request.expected_epoch != self.agent_epoch {
            return Err("PTY_EPOCH_MISMATCH");
        }
        if request.limit == 0
            || request.limit > 100
            || request.after_pty_id.len() > 256
            || request.snapshot_id.len() > 64
            || (request.after_pty_id.is_empty() != request.snapshot_id.is_empty())
        {
            return Err("PTY_INVENTORY_INVALID");
        }
        // A lost PTY (its spool outlived a crashed host) is listed until dismissed or expired,
        // unless a live session reuses its id.
        let lost = self
            .terminal_host
            .as_ref()
            .map(|host| host.lost_ptys())
            .unwrap_or_default();
        let no_digest = Vec::new();
        let mut members: Vec<_> = self
            .pty_sessions
            .iter()
            .map(|(id, session)| (id, &session.request_digest))
            .chain(
                self.pty_create_failures
                    .iter()
                    .map(|(id, failure)| (id, &failure.request_digest)),
            )
            .chain(
                lost.keys()
                    .filter(|id| {
                        !self.pty_sessions.contains_key(*id)
                            && !self.pty_create_failures.contains_key(*id)
                    })
                    .map(|id| (id, &no_digest)),
            )
            .collect();
        members.sort_by(|left, right| left.0.cmp(right.0));
        if members.len() > MAX_PTY_SESSIONS
            || members.iter().any(|(id, digest)| {
                id.is_empty()
                    || id.len() > 256
                    || !id.is_ascii()
                    || id.bytes().any(|b| b.is_ascii_control())
                    || digest.len() > 64
            })
        {
            return Err("PTY_INVENTORY_BOUNDS");
        }
        // Membership token only, not authentication or an atomic snapshot of mutable PTY state.
        let mut hasher = Sha256::new();
        for (id, digest) in &members {
            hasher.update((id.len() as u64).to_be_bytes());
            hasher.update(id.as_bytes());
            hasher.update((digest.len() as u64).to_be_bytes());
            hasher.update(digest);
        }
        let snapshot_id = format!("{:x}", hasher.finalize());
        if !request.snapshot_id.is_empty() && request.snapshot_id != snapshot_id {
            return Err("PTY_INVENTORY_CHANGED");
        }
        if !request.after_pty_id.is_empty()
            && !members.iter().any(|(id, _)| **id == request.after_pty_id)
        {
            return Err("PTY_INVENTORY_INVALID");
        }
        let remaining: Vec<_> = members
            .into_iter()
            .filter(|(id, _)| **id > request.after_pty_id)
            .collect();
        let mut entries = Vec::new();
        for (id, digest) in remaining.iter().take(request.limit as usize) {
            let mut entry = v1::PtyInventoryEntry {
                pty_id: (*id).clone(),
                request_digest: (*digest).clone(),
                state: "outcome-unknown".to_owned(),
                launch_status: "unconfirmed".to_owned(),
                ..Default::default()
            };
            if let Some(session) = self.pty_sessions.get(*id) {
                let snapshot = session
                    .handle
                    .snapshot()
                    .map_err(|_| "PTY_INVENTORY_UNAVAILABLE")?;
                entry.state = match snapshot.state {
                    pty::PtyState::Running => "running",
                    pty::PtyState::Exited => "exited",
                    pty::PtyState::Closed => "closed",
                }
                .to_owned();
                entry.pid = u64::from(snapshot.pid);
                entry.next_sequence = snapshot.next_sequence;
                entry.first_retained_sequence = snapshot.first_retained_sequence;
                entry.verified_exit = session.handle.child_reaped()
                    && (snapshot.exit_code.is_some() || snapshot.signal.is_some());
                if let Some(lifecycle) = &session.lifecycle {
                    lifecycle_facts(lifecycle, &mut entry);
                }
            } else if lost.contains_key(*id) {
                // `state` keeps the pre-1.9 vocabulary (clients validate it); `lost` says why.
                entry.lost = true;
                entry.screen_available = true;
            }
            entries.push(entry);
        }
        let next = if remaining.len() > entries.len() {
            entries
                .last()
                .ok_or("PTY_INVENTORY_UNAVAILABLE")?
                .pty_id
                .clone()
        } else {
            String::new()
        };
        Ok((entries, next, snapshot_id))
    }
}

/// 1.9 inventory fields (plan §9.1): activity, LRU key, screen and opt-in state.
fn lifecycle_facts(
    lifecycle: &super::pty_lifecycle::PtyLifecycle,
    entry: &mut v1::PtyInventoryEntry,
) {
    let screen = lifecycle.model_state() == Some(crate::terminal_screen::ModelState::Live);
    let state = lifecycle.lock();
    entry.activity_state = if state.activity.warning_closes_at().is_some() {
        "idle_warning"
    } else if state.activity.idle_busy() {
        "busy"
    } else {
        "idle"
    }
    .to_owned();
    entry.last_used_ms = state.activity.last_used();
    entry.screen_available = screen;
    entry.lifecycle_managed = lifecycle.managed();
}

#[cfg(test)]
#[path = "pty_inventory.tests.rs"]
mod tests;
