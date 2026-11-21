use bigbud_protocol::pty_lifecycle::UNSUPPORTED;

use super::*;

#[cfg(test)]
#[path = "operation_handlers.tests.rs"]
mod tests;

/// Protocol 1.9 lifecycle requests (frames 80-95). A terminal host answers them; an agent
/// without one (stdio) does not advertise the capabilities, so a conforming client never sends
/// them, and a stray one still gets a refusal it can correlate by request id.
pub(super) fn is_pty_lifecycle_request(payload: &v1::frame::Payload) -> bool {
    use v1::frame::Payload;
    matches!(
        payload,
        Payload::PtyScreenSnapshotRequest(_)
            | Payload::HostPolicyUpdateRequest(_)
            | Payload::PtyViewStateRequest(_)
            | Payload::PtyKeepOpenRequest(_)
            | Payload::PtyCloseAllRequest(_)
            | Payload::HostNoticeReplayRequest(_)
    )
}

/// Answers an unsupported lifecycle request with its typed refusal.
pub(super) fn refuse_pty_lifecycle_request(
    payload: v1::frame::Payload,
    agent_epoch: &str,
) -> v1::Frame {
    use v1::frame::Payload;
    let code = UNSUPPORTED.to_owned();
    let message = "terminal lifecycle is not supported by this agent".to_owned();
    let payload = match payload {
        Payload::PtyScreenSnapshotRequest(request) => {
            Payload::PtyScreenSnapshotHeader(Box::new(v1::PtyScreenSnapshotHeader {
                request_id: request.request_id,
                pty_id: request.pty_id,
                error_code: code,
                error_message: message,
                ..Default::default()
            }))
        }
        Payload::HostPolicyUpdateRequest(request) => {
            Payload::HostPolicyUpdateResponse(Box::new(v1::HostPolicyUpdateResponse {
                request_id: request.request_id,
                error_code: code,
                error_message: message,
                ..Default::default()
            }))
        }
        Payload::PtyViewStateRequest(request) => {
            Payload::PtyViewStateResponse(Box::new(v1::PtyViewStateResponse {
                request_id: request.request_id,
                pty_id: request.pty_id,
                accepted: false,
                error_code: code,
                error_message: message,
            }))
        }
        Payload::PtyKeepOpenRequest(request) => {
            Payload::PtyKeepOpenResponse(Box::new(v1::PtyKeepOpenResponse {
                request_id: request.request_id,
                pty_id: request.pty_id,
                accepted: false,
                error_code: code,
                error_message: message,
            }))
        }
        Payload::PtyCloseAllRequest(request) => {
            Payload::PtyCloseAllResponse(Box::new(v1::PtyCloseAllResponse {
                request_id: request.request_id,
                error_code: code,
                error_message: message,
                ..Default::default()
            }))
        }
        Payload::HostNoticeReplayRequest(request) => {
            Payload::HostNoticeReplayResponse(Box::new(v1::HostNoticeReplayResponse {
                request_id: request.request_id,
                agent_epoch: agent_epoch.to_owned(),
                error_code: code,
                ..Default::default()
            }))
        }
        _ => return protocol_error_frame(&SessionError::UnexpectedMessage),
    };
    v1::Frame {
        payload: Some(payload),
    }
}

impl AgentSession {
    /// Lifecycle requests that reach the session. The supervisor serves snapshots on its
    /// snapshot worker and runs close-all outside the session lock before they get here.
    pub(super) fn handle_pty_lifecycle_request(
        &mut self,
        payload: v1::frame::Payload,
    ) -> v1::Frame {
        use v1::frame::Payload;
        let Some(host) = self.terminal_host.clone() else {
            return refuse_pty_lifecycle_request(payload, &self.agent_epoch);
        };
        match payload {
            Payload::HostPolicyUpdateRequest(request) => {
                self.handle_host_policy_update(&host, *request)
            }
            Payload::PtyViewStateRequest(request) => self.handle_pty_view_state(*request),
            Payload::PtyKeepOpenRequest(request) => self.handle_pty_keep_open(request),
            Payload::HostNoticeReplayRequest(request) => v1::Frame {
                payload: Some(Payload::HostNoticeReplayResponse(Box::new(
                    host.replay_notices(request),
                ))),
            },
            Payload::PtyCloseAllRequest(request) => {
                let (response, closed) = self.prepare_close_all(request).execute();
                for pty_id in closed {
                    self.note_pty_closed(&pty_id);
                }
                response
            }
            other => refuse_pty_lifecycle_request(other, &self.agent_epoch),
        }
    }

    pub(super) fn handle_diagnostic_request(
        &mut self,
        request: v1::DiagnosticRequest,
    ) -> Result<v1::Frame, SessionError> {
        if request.operation_id.is_empty() {
            return Err(SessionError::MissingOperationId);
        }

        let _ = self.accept_operation(&request.operation_id, request.request_digest)?;

        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::DiagnosticResponse(
                v1::DiagnosticResponse {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    accepted: true,
                    terminal: true,
                    message: "agent-ready".to_owned(),
                },
            )),
        })
    }

    pub(super) fn handle_cancel_request(
        &mut self,
        request: v1::CancelRequest,
    ) -> Result<v1::Frame, SessionError> {
        let search_cancelled = self.search_registry.cancel(&request.operation_id)
            || self.os_index_registry.cancel(&request.operation_id);
        let (cancelled, terminal, detail) = if search_cancelled {
            (true, false, "cancellation-requested")
        } else if let Some(signal) = self.process_cancellations.get(&request.operation_id) {
            signal.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = self
                .process_operations
                .begin_cancel(&request.operation_id, Instant::now());
            (true, false, "cancellation-requested")
        } else if let Ok(snapshot) = self
            .process_operations
            .snapshot(&request.operation_id, Instant::now())
        {
            if snapshot.terminal.is_some() {
                (false, true, "operation-already-terminal")
            } else {
                (false, false, "operation-cannot-be-cancelled")
            }
        } else {
            (false, true, "operation-unknown-or-expired")
        };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::CancelResponse(v1::CancelResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                cancelled,
                terminal,
                detail: detail.to_owned(),
            })),
        })
    }

    pub(super) fn accept_operation(
        &mut self,
        operation_id: &str,
        request_digest: Vec<u8>,
    ) -> Result<bool, SessionError> {
        if operation_id.is_empty() {
            return Err(SessionError::MissingOperationId);
        }
        let now = Instant::now();
        self.accepted_operations
            .retain(|_, operation| operation.expires_at > now);
        if let Some(existing) = self.accepted_operations.get(operation_id) {
            if existing.request_digest != request_digest {
                return Err(SessionError::OperationIdConflict);
            }
            return Ok(true);
        } else {
            if self.accepted_operations.len() >= MAX_ACCEPTED_OPERATIONS {
                // Identities live for a day, so a full table must not refuse
                // new work. The identity accepted first is the least likely
                // to be retried; only a retry older than every newer identity
                // loses deduplication.
                let oldest = self
                    .accepted_operations
                    .iter()
                    .min_by_key(|(_, operation)| operation.expires_at)
                    .map(|(operation_id, _)| operation_id.clone());
                if let Some(oldest) = oldest {
                    self.accepted_operations.remove(&oldest);
                }
            }
            self.accepted_operations.insert(
                operation_id.to_owned(),
                AcceptedOperation {
                    request_digest,
                    expires_at: now + ACCEPTED_OPERATION_RETENTION,
                },
            );
        }
        Ok(false)
    }
}
