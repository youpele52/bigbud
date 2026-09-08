use super::*;

impl AgentSession {
    pub fn prepare_pty_create(
        &mut self,
        request: v1::PtyCreateRequest,
    ) -> Result<(v1::Frame, Option<pty::PtyJob>), SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        if request.pty_id.is_empty() {
            return Err(SessionError::Pty("PTY ID is required".to_owned()));
        }
        self.prune_pty_sessions();
        if let Some(existing) = self.pty_sessions.get(&request.pty_id) {
            if existing.request_digest != request.request_digest {
                return Err(SessionError::OperationIdConflict);
            }
            return Ok((
                pty_create_response_frame(&request, true, existing.handle.pid as u64, "", ""),
                None,
            ));
        }
        if self.pty_sessions.len() >= MAX_PTY_SESSIONS {
            return Err(SessionError::ResourceLimit(
                "PTY session limit reached".to_owned(),
            ));
        }
        let workspace = self.workspace(&request.workspace_handle)?;
        let cwd = workspace
            .resolve_directory(&request.cwd)
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        let environment = process_environment_from_entries(&request.environment)?;
        let cols = request.cols.clamp(1, 500) as u16;
        let rows = request.rows.clamp(1, 500) as u16;
        let job = pty::PtyHandle::spawn(
            request.pty_id.clone(),
            &cwd,
            &request.shell,
            &request.args,
            cols,
            rows,
            &environment,
        )
        .map_err(|error| SessionError::Pty(error.to_string()))?;
        let pid = job.handle.pid as u64;
        self.pty_sessions.insert(
            request.pty_id.clone(),
            PtySession {
                handle: Arc::clone(&job.handle),
                request_digest: request.request_digest.clone(),
                expires_at: None,
            },
        );
        Ok((
            pty_create_response_frame(&request, true, pid, "", ""),
            Some(job),
        ))
    }

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
            replay_gap,
        )];
        responses.extend(
            chunks
                .into_iter()
                .map(|chunk| pty_output_frame(&request.pty_id, chunk.sequence, chunk.bytes)),
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

    pub fn record_pty_output(
        &mut self,
        pty_id: &str,
        bytes: Vec<u8>,
    ) -> Result<v1::Frame, SessionError> {
        let handle = self.pty(pty_id)?;
        let chunk = handle
            .append_output(bytes)
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        Ok(pty_output_frame(pty_id, chunk.sequence, chunk.bytes))
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

    fn pty(&mut self, pty_id: &str) -> Result<Arc<pty::PtyHandle>, SessionError> {
        self.prune_pty_sessions();
        self.pty_sessions
            .get(pty_id)
            .map(|session| Arc::clone(&session.handle))
            .ok_or_else(|| SessionError::Pty("PTY is unknown or expired".to_owned()))
    }

    fn prune_pty_sessions(&mut self) {
        let now = Instant::now();
        self.pty_sessions
            .retain(|_, session| session.expires_at.is_none_or(|expires_at| expires_at > now));
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
