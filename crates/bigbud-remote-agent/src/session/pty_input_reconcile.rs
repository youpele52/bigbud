use super::*;

impl AgentSession {
    pub(super) fn handle_pty_input_reconcile(
        &self,
        request: v1::PtyInputReconcileRequest,
    ) -> v1::Frame {
        let result = self.input_receipt(&request);
        let mut response = v1::PtyInputReconcileResponse {
            request_id: request.request_id,
            agent_epoch: self.agent_epoch.clone(),
            pty_id: request.pty_id,
            create_digest: request.create_digest,
            sequence: request.sequence,
            payload_digest: request.payload_digest,
            byte_length: request.byte_length,
            ..Default::default()
        };
        match result {
            Ok((outcome, bytes_written, writer_usable)) => {
                response.accepted = true;
                response.outcome = outcome.to_owned();
                response.bytes_written = bytes_written;
                response.writer_usable = writer_usable;
            }
            Err(code) => response.error_code = code.to_owned(),
        }
        v1::Frame {
            payload: Some(v1::frame::Payload::PtyInputReconcileResponse(response)),
        }
    }

    fn input_receipt(
        &self,
        request: &v1::PtyInputReconcileRequest,
    ) -> Result<(&'static str, u64, bool), &'static str> {
        if request.expected_epoch != self.agent_epoch {
            return Err("PTY_EPOCH_MISMATCH");
        }
        if request.request_id.is_empty()
            || request.request_id.len() > 256
            || request.pty_id.is_empty()
            || request.pty_id.len() > 256
            || request.create_digest.len() != 32
            || request.payload_digest.len() != 32
            || request.sequence == 0
            || request.sequence > 9_007_199_254_740_991
            || request.byte_length > 64 * 1024
        {
            return Err("PTY_INPUT_INVALID");
        }
        let session = self
            .pty_sessions
            .get(&request.pty_id)
            .ok_or("PTY_INPUT_UNKNOWN")?;
        if session.request_digest != request.create_digest {
            return Err("PTY_INPUT_IDENTITY_CONFLICT");
        }
        #[cfg(unix)]
        {
            let digest = request
                .payload_digest
                .as_slice()
                .try_into()
                .map_err(|_| "PTY_INPUT_INVALID")?;
            let length = usize::try_from(request.byte_length).map_err(|_| "PTY_INPUT_INVALID")?;
            let receipt = session
                .handle
                .reconcile_input(request.sequence, digest, length, self.accepting_work)
                .map_err(|error| match error {
                    pty::PtyError::InputConflict => "PTY_INPUT_IDENTITY_CONFLICT",
                    pty::PtyError::InputExpired => "PTY_INPUT_EXPIRED",
                    pty::PtyError::InputSequence { .. } => "PTY_INPUT_SEQUENCE",
                    pty::PtyError::InputLimit => "PTY_INPUT_LIMIT",
                    _ => "PTY_INPUT_UNAVAILABLE",
                })?;
            let (outcome, count) = match receipt.outcome {
                pty::InputOutcome::Accepted => ("accepted", 0),
                pty::InputOutcome::Writing(n) => ("writing", n),
                pty::InputOutcome::Written(n) => ("written", n),
                pty::InputOutcome::FailedBeforeWrite => ("failed-before-write", 0),
                pty::InputOutcome::PartialUnknown(n) => ("partial-unknown", n),
                pty::InputOutcome::NotAdmitted => ("not-admitted", 0),
            };
            Ok((outcome, count as u64, receipt.writer_usable))
        }
        #[cfg(not(unix))]
        Err("PTY_INPUT_UNSUPPORTED")
    }
}

#[cfg(all(test, unix))]
#[path = "pty_input_reconcile.tests.rs"]
mod tests;
