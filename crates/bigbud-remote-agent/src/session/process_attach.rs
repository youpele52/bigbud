use super::*;

impl AgentSession {
    /// Reattaches to a process operation without ever starting it again.
    ///
    /// When the cursor fell behind the retained output window (for example,
    /// a chatty process overflowed it while the client slept), the attach
    /// still returns the snapshot, the retained output and the terminal
    /// result, marked `replay_gap`, instead of failing, as PTY attach does.
    pub fn handle_process_attach(
        &mut self,
        request: v1::ProcessAttachRequest,
    ) -> Result<Vec<v1::Frame>, SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        let now = Instant::now();
        let (chunks, replay_gap) = match self.process_operations.replay_from(
            &request.operation_id,
            request.after_sequence,
            now,
        ) {
            Ok(chunks) => (chunks, false),
            Err(operations::OperationError::ReplayGap {
                first_retained_sequence,
            }) => (
                self.process_operations
                    .replay_from(
                        &request.operation_id,
                        first_retained_sequence.saturating_sub(1),
                        now,
                    )
                    .map_err(|error| SessionError::ProcessReplay(error.to_string()))?,
                true,
            ),
            Err(error) => return Err(SessionError::ProcessReplay(error.to_string())),
        };
        let snapshot = self
            .process_operations
            .snapshot(&request.operation_id, now)
            .map_err(operation_error)?;
        let mut responses = vec![process_attach_response_frame(
            &request.request_id,
            &snapshot,
            replay_gap,
        )];
        responses.extend(chunks.into_iter().map(|chunk| {
            process_output_frame(
                &request.operation_id,
                chunk.sequence,
                chunk.stream,
                chunk.bytes,
            )
        }));
        if let Some(terminal) = snapshot.terminal {
            let mut completed = process_completed_frame(
                &request.request_id,
                &request.operation_id,
                &terminal,
                false,
            );
            if let Some(v1::frame::Payload::ProcessCompleted(completed)) =
                completed.payload.as_mut()
            {
                completed.replay_gap = replay_gap;
            }
            responses.push(completed);
        }
        Ok(responses)
    }

    pub(super) fn handle_process_output_ack(&mut self, request: v1::ProcessOutputAck) -> v1::Frame {
        let (accepted, error_code, error_message) = match self.process_operations.acknowledge(
            &request.operation_id,
            request.acknowledged_sequence,
            Instant::now(),
        ) {
            Ok(()) => match self.append_process_journal(&JournalRecord::Acknowledged {
                operation_id: request.operation_id.clone(),
                acknowledged_sequence: request.acknowledged_sequence,
            }) {
                Ok(()) => (true, String::new(), String::new()),
                Err(error) => (false, "PROCESS_ACK_ERROR".to_owned(), error.to_string()),
            },
            Err(error) => (false, "PROCESS_ACK_ERROR".to_owned(), error.to_string()),
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::ProcessAckResponse(
                v1::ProcessAckResponse {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    accepted,
                    error_code,
                    error_message,
                },
            )),
        }
    }
}
