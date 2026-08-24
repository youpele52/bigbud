use bigbud_protocol::v1;

use super::{AgentSession, SessionError, WorkspaceRoot, workspace_error_code};
use crate::workspace::WorkspaceWatchRegistry;

struct WorkspaceWatchRegistration {
    pub subscription_id: String,
    pub workspace: WorkspaceRoot,
    pub relative_path: String,
}

pub struct PreparedWorkspaceWatch {
    pub response: v1::WorkspaceWatchStartResponse,
    registration: Option<WorkspaceWatchRegistration>,
}

impl PreparedWorkspaceWatch {
    pub fn register(mut self, registry: &WorkspaceWatchRegistry) -> v1::Frame {
        if let Some(registration) = self.registration {
            match registry.subscribe(
                &registration.subscription_id,
                registration.workspace,
                &registration.relative_path,
            ) {
                Ok(started) => {
                    self.response.generation = started.generation;
                    self.response.backend = started.backend;
                }
                Err(error) => {
                    self.response.accepted = false;
                    self.response.error_code = error.code().to_owned();
                    self.response.error_message = error.to_string();
                }
            }
        }
        v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceWatchStartResponse(
                self.response,
            )),
        }
    }
}

impl AgentSession {
    pub fn prepare_workspace_watch_start(
        &self,
        request: v1::WorkspaceWatchStartRequest,
    ) -> Result<PreparedWorkspaceWatch, SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        if request.subscription_id.is_empty() {
            return Err(SessionError::MissingWorkspaceWatchSubscriptionId);
        }
        let workspace = self.workspace(&request.workspace_handle)?.clone();
        let relative_path = if request.path == "." {
            String::new()
        } else {
            request.path
        };
        let validation = workspace.resolve_directory(&relative_path);
        let (accepted, error_code, error_message) = match validation {
            Ok(_) => (true, String::new(), String::new()),
            Err(error) => (
                false,
                workspace_error_code(&error).to_owned(),
                error.to_string(),
            ),
        };
        let registration = accepted.then(|| WorkspaceWatchRegistration {
            subscription_id: request.subscription_id.clone(),
            workspace,
            relative_path,
        });
        Ok(PreparedWorkspaceWatch {
            response: v1::WorkspaceWatchStartResponse {
                request_id: request.request_id,
                subscription_id: request.subscription_id,
                accepted,
                generation: 0,
                backend: String::new(),
                error_code,
                error_message,
            },
            registration,
        })
    }

    pub fn workspace_watch_stop_response(
        &self,
        request: v1::WorkspaceWatchStopRequest,
        stopped: bool,
    ) -> Result<v1::Frame, SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        if request.subscription_id.is_empty() {
            return Err(SessionError::MissingWorkspaceWatchSubscriptionId);
        }
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceWatchStopResponse(
                v1::WorkspaceWatchStopResponse {
                    request_id: request.request_id,
                    subscription_id: request.subscription_id,
                    stopped,
                },
            )),
        })
    }
}
