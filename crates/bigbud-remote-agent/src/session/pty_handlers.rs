use super::*;

pub(super) struct PtySession {
    pub(super) handle: Arc<pty::PtyHandle>,
    pub(super) request_digest: Vec<u8>,
    pub(super) expires_at: Option<Instant>,
    /// Present only for PTYs created by a 1.9 client on a terminal host (plan §8.7 opt-in).
    pub(super) lifecycle: Option<Arc<super::pty_lifecycle::PtyLifecycle>>,
    /// The workspace root this session holds a reference on (plan §8.10).
    pub(super) workspace_handle: String,
}

impl AgentSession {
    pub fn handle_pty_attach(
        &mut self,
        request: v1::PtyAttachRequest,
    ) -> Result<Vec<v1::Frame>, SessionError> {
        let handle = self.pty(&request.pty_id)?;
        let snapshot = handle
            .snapshot()
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        let (chunks, replay_gap) = match handle.replay(request.after_sequence) {
            Ok(chunks) => (chunks, false),
            Err(pty::PtyError::ReplayGap { .. }) => (Vec::new(), true),
            Err(error) => return Err(SessionError::Pty(error.to_string())),
        };
        let mut responses = vec![pty_attach_response_frame(
            &request.request_id,
            &request.pty_id,
            &snapshot,
            handle.launch_outcome(),
            replay_gap,
        )];
        responses.extend(
            chunks.into_iter().map(|chunk| {
                pty_output_frame(&request.pty_id, chunk.sequence, chunk.bytes.to_vec())
            }),
        );
        if snapshot.state != pty::PtyState::Running {
            responses.push(pty_exited_frame(
                &request.pty_id,
                snapshot.exit_code,
                snapshot.signal,
            ));
        }
        Ok(responses)
    }

    /// Appends one output chunk to the replay ring and returns its frame plus the shared
    /// chunk (the screen feed and spool take the same allocation, not copies).
    pub fn record_pty_output(
        &mut self,
        pty_id: &str,
        bytes: pty::OutputBytes,
    ) -> Result<(v1::Frame, pty::PtyOutputChunk), SessionError> {
        let handle = self.pty(pty_id)?;
        let chunk = handle
            .append_output(bytes)
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        let frame = pty_output_frame(pty_id, chunk.sequence, chunk.bytes.to_vec());
        Ok((frame, chunk))
    }

    pub fn complete_pty(
        &mut self,
        pty_id: &str,
        exit_code: Option<i32>,
        signal: Option<i32>,
    ) -> Result<v1::Frame, SessionError> {
        let handle = self.pty(pty_id)?;
        handle
            .mark_exited(exit_code, signal)
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        if let Some(session) = self.pty_sessions.get_mut(pty_id) {
            session.expires_at = Some(Instant::now() + PTY_RESULT_RETENTION);
        }
        Ok(pty_exited_frame(pty_id, exit_code, signal))
    }

    pub fn pty_operation_handle(
        &mut self,
        pty_id: &str,
    ) -> Result<Arc<pty::PtyHandle>, SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        self.pty(pty_id)
    }

    fn pty(&mut self, pty_id: &str) -> Result<Arc<pty::PtyHandle>, SessionError> {
        self.prune_pty_sessions();
        self.pty_sessions
            .get(pty_id)
            .map(|session| Arc::clone(&session.handle))
            .ok_or_else(|| SessionError::Pty("PTY is unknown or expired".to_owned()))
    }

    pub(super) fn prune_pty_sessions(&mut self) {
        let now = Instant::now();
        let expired = self
            .pty_sessions
            .iter()
            .filter(|(_, session)| {
                session.handle.child_reaped()
                    && session
                        .expires_at
                        .is_some_and(|expires_at| expires_at <= now)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            self.retire_pty_session(&id);
        }
    }

    pub(super) fn handle_pty_input(&mut self, request: v1::PtyInput) -> v1::Frame {
        let result = self.pty(&request.pty_id).and_then(|handle| {
            handle
                .write_input(request.sequence, &request.bytes)
                .map(|_| ())
                .map_err(|error| SessionError::Pty(error.to_string()))
        });
        pty_control_response_frame(
            request.request_id,
            request.pty_id,
            result,
            "PTY_INPUT_ERROR",
            "input",
        )
    }

    pub(super) fn handle_pty_output_ack(&mut self, request: v1::PtyOutputAck) -> v1::Frame {
        let result = self.pty(&request.pty_id).and_then(|handle| {
            handle
                .acknowledge(request.acknowledged_sequence)
                .map_err(|error| SessionError::Pty(error.to_string()))
        });
        pty_control_response_frame(
            request.request_id,
            request.pty_id,
            result,
            "PTY_ACK_ERROR",
            "ack",
        )
    }

    pub(super) fn handle_pty_resize(&mut self, request: v1::PtyResizeRequest) -> v1::Frame {
        let result = self.pty(&request.pty_id).and_then(|handle| {
            handle
                .resize(
                    request.cols.clamp(1, 500) as u16,
                    request.rows.clamp(1, 500) as u16,
                )
                .map_err(|error| SessionError::Pty(error.to_string()))
        });
        pty_control_response_frame(
            request.request_id,
            request.pty_id,
            result,
            "PTY_RESIZE_ERROR",
            "resize",
        )
    }

    pub(super) fn handle_pty_signal(&mut self, request: v1::PtySignalRequest) -> v1::Frame {
        let result = self.pty(&request.pty_id).and_then(|handle| {
            handle
                .signal(&request.signal)
                .map_err(|error| SessionError::Pty(error.to_string()))
        });
        pty_control_response_frame(
            request.request_id,
            request.pty_id,
            result,
            "PTY_SIGNAL_ERROR",
            "signal",
        )
    }

    pub(super) fn handle_pty_close(&mut self, request: v1::PtyCloseRequest) -> v1::Frame {
        let pty_id = request.pty_id.clone();
        let result = self.pty(&pty_id).and_then(|handle| {
            handle
                .close(request.terminate)
                .map_err(|error| SessionError::Pty(error.to_string()))
        });
        if result.is_ok()
            && let Some(session) = self.pty_sessions.get_mut(&pty_id)
        {
            session.expires_at = Some(Instant::now() + PTY_RESULT_RETENTION);
        }
        pty_control_response_frame(
            request.request_id,
            pty_id,
            result,
            "PTY_CLOSE_ERROR",
            "close",
        )
    }
}
