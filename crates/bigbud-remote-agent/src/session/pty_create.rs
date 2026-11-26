use super::pty_lifecycle::{LifecycleOptions, PtyLifecycle};
use super::*;

#[path = "pty_create.admission.rs"]
mod admission;
use admission::Admission;

pub(super) struct PtyCreateFailure {
    pub(super) request_digest: Vec<u8>,
    pub(super) error: String,
    pub(super) created_at: Instant,
}

/// True when the create comes from a 1.9 client that asked for any lifecycle feature. Older
/// clients' creates never get lifecycle state, so their PTYs behave exactly as before.
fn wants_lifecycle(request: &v1::PtyCreateRequest) -> bool {
    request.lifecycle_managed
        || request.spool
        || request.local_launch
        || request.screen_scrollback_rows > 0
        || !request.activity_source.is_empty()
}

fn pane_identity(request: &v1::PtyCreateRequest) -> Option<super::pty_handlers::PtyPaneIdentity> {
    let kind = if !request.pane_kind.is_empty() {
        request.pane_kind.clone()
    } else if request.local_launch
        && std::path::Path::new(&request.shell)
            .file_name()
            .is_some_and(|name| name == "ssh")
    {
        "managed-ssh".to_owned()
    } else {
        "local".to_owned()
    };
    if !matches!(kind.as_str(), "local" | "managed-ssh") {
        return None;
    }
    if request.thread_id.is_empty() && request.pane_id.is_empty() && request.pane_kind.is_empty() {
        // Legacy create: no application identity was supplied, but the kind is still known.
        return Some(super::pty_handlers::PtyPaneIdentity {
            thread_id: String::new(),
            pane_id: String::new(),
            kind,
        });
    }
    let bounded = |value: &str| {
        value.len() <= 256 && value.is_ascii() && !value.bytes().any(|b| b.is_ascii_control())
    };
    if !bounded(&request.thread_id) || !bounded(&request.pane_id) {
        return None;
    }
    Some(super::pty_handlers::PtyPaneIdentity {
        thread_id: request.thread_id.clone(),
        pane_id: request.pane_id.clone(),
        kind,
    })
}

impl AgentSession {
    pub fn prepare_pty_create(
        &mut self,
        request: v1::PtyCreateRequest,
    ) -> Result<(v1::Frame, Option<pty::PtyJob>), SessionError> {
        let local_launch = request.local_launch;
        self.prepare_pty_create_with(request, move |request, cwd, environment| {
            pty::PtyHandle::spawn_with_launch(
                request.pty_id.clone(),
                cwd,
                &request.shell,
                &request.args,
                (
                    request.cols.clamp(1, 500) as u16,
                    request.rows.clamp(1, 500) as u16,
                ),
                environment,
                local_launch,
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
        let host = self.terminal_host.clone();
        let local_launch = request.local_launch;
        let identity = pane_identity(&request);
        if identity.is_none() {
            return Err(SessionError::Pty("PTY_PANE_IDENTITY_INVALID".to_owned()));
        }
        let requested_kind = identity.as_ref().map(|identity| identity.kind.clone());
        if requested_kind.as_deref() == Some("managed-ssh")
            && host.as_ref().is_some_and(|host| host.ssh_spawn_retired())
        {
            return Err(SessionError::Pty("SSH_SPAWN_RETIRED".to_owned()));
        }
        if local_launch && !host.as_ref().is_some_and(|host| host.local_desktop_host()) {
            return Err(SessionError::Pty(
                "local launch requires a --local-desktop-host terminal host".to_owned(),
            ));
        }
        let workspace = self.workspace(&request.workspace_handle)?;
        let cwd = workspace
            .resolve_directory(&request.cwd)
            .map_err(|error| SessionError::Pty(error.to_string()))?;
        let environment = if local_launch {
            validate_local_launch_environment(&request.environment)?
        } else {
            process_environment_from_entries(&request.environment)?
        };
        if request.profile_launch {
            pty_profile::validate(&request.shell, &request.args)?;
        }
        let evicted = match self.admit_pty(&request) {
            Admission::Admit { evicted } => evicted,
            Admission::Refuse(frame) => return Ok((*frame, None)),
        };
        if self.pty_sessions.len() + self.pty_create_failures.len() >= MAX_PTY_SESSIONS
            && !(host.is_some() && self.make_room_for_pty())
        {
            return Err(SessionError::ResourceLimit(
                "PTY session limit reached".to_owned(),
            ));
        }
        // Bind identity before native dispatch. Native errors may follow child creation,
        // so retain them for this session's lifetime, never as expiring PTY results.
        self.pty_create_failures.insert(
            request.pty_id.clone(),
            PtyCreateFailure {
                request_digest: request.request_digest.clone(),
                error: "PTY create was admitted; launch outcome is unknown".to_owned(),
                created_at: Instant::now(),
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
                        created_at: Instant::now(),
                    },
                );
                return Err(SessionError::Pty(error));
            }
        };
        let lifecycle = host.filter(|_| wants_lifecycle(&request)).map(|host| {
            PtyLifecycle::new(
                Arc::clone(&job.handle),
                host,
                LifecycleOptions {
                    managed: request.lifecycle_managed,
                    screen_scrollback_rows: LifecycleOptions::scrollback_rows(
                        request.screen_scrollback_rows,
                    ),
                    spool: request.spool,
                    owner_hint_source: request.activity_source == "owner-hint",
                    cols: request.cols.clamp(1, 500) as u16,
                    rows: request.rows.clamp(1, 500) as u16,
                },
            )
        });
        let managed = lifecycle.as_ref().is_some_and(|l| l.managed());
        self.pty_sessions.insert(
            request.pty_id.clone(),
            PtySession {
                handle: Arc::clone(&job.handle),
                request_digest: request.request_digest.clone(),
                expires_at: None,
                pane_identity: identity.clone(),
                lifecycle,
                workspace_handle: request.workspace_handle.clone(),
            },
        );
        self.retain_workspace_ref(&request.workspace_handle);
        // Successful creates retain their existing live/result lifecycle instead.
        self.pty_create_failures.remove(&request.pty_id);
        let mut frame = pty_create_response_frame(&request, &job.handle);
        if let Some(v1::frame::Payload::PtyCreateResponse(response)) = &mut frame.payload {
            response.evicted_pty_id = evicted.unwrap_or_default();
            if managed {
                let (limit, live) = self.managed_live_counts();
                response.limit = limit;
                response.live_count = live;
            }
        }
        Ok((frame, Some(job)))
    }
}

#[cfg(all(test, unix))]
#[path = "pty_create.tests.rs"]
mod tests;
