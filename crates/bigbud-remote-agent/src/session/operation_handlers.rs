use super::*;

impl AgentSession {
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
        let (cancelled, terminal, detail) =
            if let Some(signal) = self.process_cancellations.get(&request.operation_id) {
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
