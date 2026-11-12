use super::*;

pub(super) struct PtyCreateFailure {
    request_digest: Vec<u8>,
    error: String,
}

impl AgentSession {
    pub fn prepare_pty_create(
        &mut self,
        request: v1::PtyCreateRequest,
    ) -> Result<(v1::Frame, Option<pty::PtyJob>), SessionError> {
        self.prepare_pty_create_with(request, |request, cwd, environment| {
            pty::PtyHandle::spawn(
                request.pty_id.clone(),
                cwd,
                &request.shell,
                &request.args,
                request.cols.clamp(1, 500) as u16,
                request.rows.clamp(1, 500) as u16,
                environment,
            )
        })
    }

    fn prepare_pty_create_with(
        &mut self,
        request: v1::PtyCreateRequest,
        spawn: impl FnOnce(
            &v1::PtyCreateRequest,
            &std::path::Path,
            &[(String, String)],
        ) -> Result<pty::PtyJob, pty::PtyError>,
    ) -> Result<(v1::Frame, Option<pty::PtyJob>), SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        if !self.is_accepting_work() {
            return Err(SessionError::Restarting);
        }
        if request.pty_id.is_empty() {
            return Err(SessionError::Pty("PTY ID is required".to_owned()));
        }
        self.prune_pty_sessions();
        if let Some(existing) = self.pty_sessions.get(&request.pty_id) {
            if existing.request_digest != request.request_digest {
                return Err(SessionError::OperationIdConflict);
            }
            return Ok((pty_create_response_frame(&request, &existing.handle), None));
        }
        if let Some(failure) = self.pty_create_failures.get(&request.pty_id) {
            if failure.request_digest != request.request_digest {
                return Err(SessionError::OperationIdConflict);
            }
            return Err(SessionError::Pty(failure.error.clone()));
        }
        if self.pty_sessions.len() + self.pty_create_failures.len() >= MAX_PTY_SESSIONS {
            return Err(SessionError::ResourceLimit(
                "PTY session limit reached".to_owned(),
            ));
        }
        let workspace = self.workspace(&request.workspace_handle)?;
        let cwd = workspace
            .resolve_directory(&request.cwd)
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        let environment = process_environment_from_entries(&request.environment)?;
        if request.profile_launch {
            pty_profile::validate(&request.shell, &request.args)?;
        }
        // Bind identity before native dispatch. Native errors may follow child creation,
        // so retain them for this session's lifetime, never as expiring PTY results.
        self.pty_create_failures.insert(
            request.pty_id.clone(),
            PtyCreateFailure {
                request_digest: request.request_digest.clone(),
                error: "PTY create was admitted; launch outcome is unknown".to_owned(),
            },
        );
        let job = match spawn(&request, &cwd, &environment) {
            Ok(job) => job,
            Err(error) => {
                let error = error.to_string();
                self.pty_create_failures.insert(
                    request.pty_id.clone(),
                    PtyCreateFailure {
                        request_digest: request.request_digest,
                        error: error.clone(),
                    },
                );
                return Err(SessionError::Pty(error));
            }
        };
        self.pty_sessions.insert(
            request.pty_id.clone(),
            PtySession {
                handle: Arc::clone(&job.handle),
                request_digest: request.request_digest.clone(),
                expires_at: None,
            },
        );
        // Successful creates retain their existing live/result lifecycle instead.
        self.pty_create_failures.remove(&request.pty_id);
        Ok((pty_create_response_frame(&request, &job.handle), Some(job)))
    }
}

#[cfg(all(test, unix))]
#[path = "pty_create.tests.rs"]
mod tests;
