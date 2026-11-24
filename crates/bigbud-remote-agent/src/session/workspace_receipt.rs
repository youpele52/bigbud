use super::*;

impl AgentSession {
    /// Records that an accepted write operation put bytes with this hash on disk.
    pub(super) fn record_write_receipt(&mut self, operation_id: &str, result_sha256: String) {
        if let Some(operation) = self.accepted_operations.get_mut(operation_id) {
            operation.result_sha256 = Some(result_sha256);
        }
    }

    /// `workspace.write` 1.2 receipt query. Read-only: it never performs or retries a write.
    /// `applied` is definitive only when true; a missing receipt cannot rule out a write frame
    /// from a lost connection that this agent has not processed yet.
    pub(super) fn handle_write_receipt(&mut self, request: v1::WriteReceiptRequest) -> v1::Frame {
        let now = Instant::now();
        self.accepted_operations
            .retain(|_, operation| operation.expires_at > now);
        let mut response = v1::WriteReceiptResponse {
            request_id: request.request_id,
            operation_id: request.operation_id,
            ..Default::default()
        };
        if response.operation_id.is_empty() {
            response.error_code = "MISSING_OPERATION_ID".to_owned();
            response.error_message = SessionError::MissingOperationId.to_string();
        } else if let Some(operation) = self.accepted_operations.get(&response.operation_id) {
            if operation.request_digest != request.request_digest {
                response.error_code = "OPERATION_ID_CONFLICT".to_owned();
                response.error_message = SessionError::OperationIdConflict.to_string();
            } else if let Some(result_sha256) = &operation.result_sha256 {
                response.applied = true;
                response.result_sha256 = result_sha256.clone();
            }
        }
        v1::Frame {
            payload: Some(v1::frame::Payload::WriteReceiptResponse(response)),
        }
    }
}
