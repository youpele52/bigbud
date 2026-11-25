use super::*;

pub(super) const HOST_RETIREMENT_CAPABILITY: &str = "terminal.host-retirement";
const MAX_PANES: usize = 64;
const MAX_IDENTITY: usize = 256;

fn owner_artifact_id() -> String {
    format!(
        "{}@{}",
        crate::identity::build_version(),
        crate::identity::build_digest()
    )
}

fn bounded_identity(value: &str) -> bool {
    value.len() <= MAX_IDENTITY && value.is_ascii() && !value.bytes().any(|b| b.is_ascii_control())
}

fn inventory_refusal(request: &v1::TerminalHostInventoryRequest, code: &str) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::TerminalHostInventoryResponse(Box::new(
            v1::TerminalHostInventoryResponse {
                request_id: request.request_id.clone(),
                error_code: code.to_owned(),
                ..Default::default()
            },
        ))),
    }
}

fn retire_refusal(
    request: &v1::TerminalHostRetireSshSpawnRequest,
    epoch: &str,
    code: &str,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::TerminalHostRetireSshSpawnResponse(
            Box::new(v1::TerminalHostRetireSshSpawnResponse {
                request_id: request.request_id.clone(),
                agent_epoch: epoch.to_owned(),
                error_code: code.to_owned(),
                error_message: "the SSH spawn retirement was refused".to_owned(),
                ..Default::default()
            }),
        )),
    }
}

impl AgentSession {
    /// Read-only and bounded. Only live sessions with a stored identity are listed; a missing
    /// pane is never retirement evidence.
    pub(super) fn handle_terminal_host_inventory(
        &self,
        request: v1::TerminalHostInventoryRequest,
    ) -> v1::Frame {
        let Some(host) = &self.terminal_host else {
            return inventory_refusal(&request, "HOST_RETIREMENT_UNAVAILABLE");
        };
        if request.expected_epoch != self.agent_epoch {
            return inventory_refusal(&request, "HOST_EPOCH_MISMATCH");
        }
        if request.max_panes == 0 || request.max_panes as usize > MAX_PANES {
            return inventory_refusal(&request, "HOST_INVENTORY_INVALID");
        }
        let artifact = owner_artifact_id();
        let mut panes: Vec<v1::TerminalHostPane> = self
            .pty_sessions
            .iter()
            .filter_map(|(pty_id, session)| {
                let identity = session.pane_identity.as_ref()?;
                Some(v1::TerminalHostPane {
                    pty_id: pty_id.clone(),
                    thread_id: identity.thread_id.clone(),
                    pane_id: identity.pane_id.clone(),
                    kind: identity.kind.clone(),
                    owner_artifact_id: artifact.clone(),
                    lease_id: pty_id.clone(),
                    can_retire_ssh_spawn: identity.kind == "managed-ssh",
                })
            })
            .collect();
        panes.sort_by(|left, right| left.pty_id.cmp(&right.pty_id));
        let truncated = panes.len() > request.max_panes as usize;
        panes.truncate(request.max_panes as usize);
        v1::Frame {
            payload: Some(v1::frame::Payload::TerminalHostInventoryResponse(Box::new(
                v1::TerminalHostInventoryResponse {
                    request_id: request.request_id,
                    agent_epoch: self.agent_epoch.clone(),
                    agent_version: crate::identity::build_version().to_owned(),
                    build_digest: crate::identity::build_digest().to_owned(),
                    owner_artifact_id: artifact,
                    panes,
                    truncated,
                    ssh_spawn_retirement_available: host.local_desktop_host(),
                    accepted: true,
                    error_code: String::new(),
                },
            ))),
        }
    }

    /// All-or-nothing. Every lease must be an exact live managed-SSH pane of this epoch; then
    /// the host durably refuses new managed-SSH creates and keeps serving non-SSH panes.
    pub(super) fn handle_terminal_host_retire_ssh_spawn(
        &self,
        request: v1::TerminalHostRetireSshSpawnRequest,
    ) -> v1::Frame {
        let Some(host) = &self.terminal_host else {
            return retire_refusal(&request, &self.agent_epoch, "HOST_RETIREMENT_UNAVAILABLE");
        };
        if !host.local_desktop_host() {
            return retire_refusal(&request, &self.agent_epoch, "HOST_RETIREMENT_UNAVAILABLE");
        }
        if request.expected_epoch != self.agent_epoch {
            return retire_refusal(&request, &self.agent_epoch, "HOST_EPOCH_MISMATCH");
        }
        if request.expected_build_digest != crate::identity::build_digest() {
            return retire_refusal(&request, &self.agent_epoch, "HOST_BUILD_MISMATCH");
        }
        let mut seen = std::collections::BTreeSet::new();
        if request.lease_ids.is_empty()
            || request.lease_ids.len() > MAX_PANES
            || request
                .lease_ids
                .iter()
                .any(|lease| !bounded_identity(lease) || !seen.insert(lease.clone()))
        {
            return retire_refusal(&request, &self.agent_epoch, "HOST_RETIREMENT_INVALID");
        }
        for lease in &request.lease_ids {
            let Some(session) = self.pty_sessions.get(lease) else {
                return retire_refusal(&request, &self.agent_epoch, "HOST_LEASE_MISMATCH");
            };
            let Some(identity) = session.pane_identity.as_ref() else {
                return retire_refusal(&request, &self.agent_epoch, "HOST_LEASE_MISMATCH");
            };
            if identity.kind != "managed-ssh" {
                return retire_refusal(&request, &self.agent_epoch, "HOST_LEASE_MISMATCH");
            }
            if session.handle.child_reaped() {
                return retire_refusal(&request, &self.agent_epoch, "HOST_LEASE_MISMATCH");
            }
        }
        if host.retire_ssh_spawn().is_err() {
            return retire_refusal(&request, &self.agent_epoch, "HOST_RETIREMENT_WRITE_FAILED");
        }
        let mut retired = request.lease_ids;
        retired.sort();
        v1::Frame {
            payload: Some(v1::frame::Payload::TerminalHostRetireSshSpawnResponse(
                Box::new(v1::TerminalHostRetireSshSpawnResponse {
                    request_id: request.request_id,
                    agent_epoch: self.agent_epoch.clone(),
                    accepted: true,
                    retired_lease_ids: retired,
                    ssh_spawn_retired: true,
                    error_code: String::new(),
                    error_message: String::new(),
                }),
            )),
        }
    }
}
