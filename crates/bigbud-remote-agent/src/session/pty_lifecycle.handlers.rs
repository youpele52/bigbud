//! Protocol 1.9 lifecycle requests that are cheap enough for the session lock (frames 85, 87,
//! 89, 94), plus the close-all preparation, whose closes run outside it (frame 91).

use super::pty_lifecycle::PtyLifecycle;
use super::pty_lifecycle_host::{HostLifecycle, kind};
use super::pty_lifecycle_responder::parse_color;
use super::*;
use crate::terminal_policy::{OwnerHint, ViewState};
use crate::terminal_screen::ReplyContext;

type Refusal = (&'static str, String);

/// Close-all targets resolved under the session lock; [`PreparedCloseAll::execute`] closes them
/// without it.
pub struct PreparedCloseAll {
    request_id: String,
    targets: Vec<(Arc<pty::PtyHandle>, Option<Arc<PtyLifecycle>>)>,
}

impl PreparedCloseAll {
    /// Returns the response and the ids that were closed (for session retention).
    pub fn execute(self) -> (v1::Frame, Vec<String>) {
        let mut closed = Vec::new();
        let mut closing = Vec::new();
        for (handle, lifecycle) in self.targets {
            let done = match &lifecycle {
                Some(lifecycle) => lifecycle.close_if(kind::QUIT_CLOSED, |_, _| true),
                None => handle.is_running() && handle.close(true).is_ok(),
            };
            if done {
                closed.push(handle.id.clone());
                closing.push(handle);
            }
        }
        // Every close escalates in parallel; the response waits until each child is reaped
        // or its escalation ended (R8), never reporting a survivor as closed early.
        let deadline = pty::PtyHandle::close_deadline();
        for handle in &closing {
            let _outcome = handle.wait_closed(deadline);
        }
        let response = v1::PtyCloseAllResponse {
            request_id: self.request_id,
            accepted: true,
            closed_count: u32::try_from(closed.len()).unwrap_or(u32::MAX),
            ..Default::default()
        };
        let frame = v1::Frame {
            payload: Some(v1::frame::Payload::PtyCloseAllResponse(Box::new(response))),
        };
        (frame, closed)
    }
}

impl AgentSession {
    pub(crate) fn terminal_host(&self) -> Option<Arc<HostLifecycle>> {
        self.terminal_host.clone()
    }

    /// Every PTY with lifecycle state, for the policy loop and host reports.
    pub(crate) fn lifecycle_ptys(&mut self) -> Vec<Arc<PtyLifecycle>> {
        self.prune_pty_sessions();
        self.pty_sessions
            .values()
            .filter_map(|session| session.lifecycle.clone())
            .collect()
    }

    /// Live PTYs of any kind (the self-exit check counts unmanaged ones too).
    pub(crate) fn live_pty_count(&mut self) -> usize {
        self.prune_pty_sessions();
        self.pty_sessions
            .values()
            .filter(|session| session.handle.is_running())
            .count()
    }

    pub(crate) fn pty_lifecycle(&mut self, pty_id: &str) -> Result<Arc<PtyLifecycle>, Refusal> {
        self.prune_pty_sessions();
        match self.pty_sessions.get(pty_id) {
            None => Err(("PTY_UNKNOWN", "PTY is unknown or expired".to_owned())),
            Some(session) => session.lifecycle.clone().ok_or((
                "PTY_LIFECYCLE_UNAVAILABLE",
                "PTY was created without terminal lifecycle".to_owned(),
            )),
        }
    }

    /// Resolves a snapshot request: a live PTY's screen, a lost PTY's spool, or a refusal.
    pub(crate) fn snapshot_source(&mut self, pty_id: &str) -> super::pty_screen::SnapshotSource {
        use super::pty_screen::SnapshotSource;
        match self.pty_lifecycle(pty_id) {
            Ok(lifecycle) => SnapshotSource::Live(lifecycle),
            Err(("PTY_UNKNOWN", _))
                if self
                    .terminal_host
                    .as_ref()
                    .is_some_and(|host| host.is_lost(pty_id)) =>
            {
                match &self.terminal_host {
                    Some(host) => SnapshotSource::Cold(Arc::clone(host)),
                    None => SnapshotSource::Refused("PTY_UNKNOWN", String::new()),
                }
            }
            Err((code, message)) => SnapshotSource::Refused(code, message),
        }
    }

    /// Closing a `lost` PTY dismisses it: its spool is deleted at once (plan §8.3 retention).
    pub(super) fn dismiss_lost_pty(&mut self, pty_id: &str) -> bool {
        let Some(host) = self.terminal_host.clone() else {
            return false;
        };
        if self.pty_sessions.contains_key(pty_id) || !host.is_lost(pty_id) {
            return false;
        }
        host.forget_lost(pty_id);
        if let Some(store) = host.spool()
            && let Err(error) = store.remove(pty_id)
        {
            eprintln!("lost terminal spool left for the sweep: {}", error.code());
        }
        true
    }

    /// A host-initiated close: keep the result for the usual retention window.
    pub(crate) fn note_pty_closed(&mut self, pty_id: &str) {
        if let Some(session) = self.pty_sessions.get_mut(pty_id)
            && session.expires_at.is_none()
        {
            session.expires_at = Some(Instant::now() + PTY_RESULT_RETENTION);
        }
    }

    pub fn prepare_close_all(&mut self, request: v1::PtyCloseAllRequest) -> PreparedCloseAll {
        self.prune_pty_sessions();
        let targets = self
            .pty_sessions
            .values()
            .filter(|session| {
                !request.managed_only || session.lifecycle.as_ref().is_some_and(|l| l.managed())
            })
            .map(|session| (Arc::clone(&session.handle), session.lifecycle.clone()))
            .collect();
        PreparedCloseAll {
            request_id: request.request_id,
            targets,
        }
    }

    pub(super) fn handle_host_policy_update(
        &mut self,
        host: &HostLifecycle,
        request: v1::HostPolicyUpdateRequest,
    ) -> v1::Frame {
        let effective = host.apply_policy(request.policy.as_ref());
        let response = v1::HostPolicyUpdateResponse {
            request_id: request.request_id,
            accepted: true,
            effective: Some(effective),
            ..Default::default()
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::HostPolicyUpdateResponse(Box::new(
                response,
            ))),
        }
    }

    pub(super) fn handle_pty_view_state(&mut self, request: v1::PtyViewStateRequest) -> v1::Frame {
        let result = self
            .pty_lifecycle(&request.pty_id)
            .and_then(|lifecycle| apply_view_state(&lifecycle, &request));
        let (accepted, error_code, error_message) = outcome(result);
        v1::Frame {
            payload: Some(v1::frame::Payload::PtyViewStateResponse(Box::new(
                v1::PtyViewStateResponse {
                    request_id: request.request_id,
                    pty_id: request.pty_id,
                    accepted,
                    error_code,
                    error_message,
                },
            ))),
        }
    }

    pub(super) fn handle_pty_keep_open(&mut self, request: v1::PtyKeepOpenRequest) -> v1::Frame {
        let result = self
            .pty_lifecycle(&request.pty_id)
            .map(|lifecycle| lifecycle.keep_open());
        let (accepted, error_code, error_message) = outcome(result);
        v1::Frame {
            payload: Some(v1::frame::Payload::PtyKeepOpenResponse(Box::new(
                v1::PtyKeepOpenResponse {
                    request_id: request.request_id,
                    pty_id: request.pty_id,
                    accepted,
                    error_code,
                    error_message,
                },
            ))),
        }
    }
}

fn outcome(result: Result<(), Refusal>) -> (bool, String, String) {
    match result {
        Ok(()) => (true, String::new(), String::new()),
        Err((code, message)) => (false, code.to_owned(), message),
    }
}

fn apply_view_state(
    lifecycle: &PtyLifecycle,
    request: &v1::PtyViewStateRequest,
) -> Result<(), Refusal> {
    let invalid = |what: &str| ("INVALID_ARGUMENT", format!("invalid {what}"));
    let view = match request.view_state.as_str() {
        "visible" => ViewState::Visible,
        "hidden" => ViewState::Hidden,
        _ => return Err(invalid("view_state")),
    };
    let hint = match request.owner_busy_hint.as_str() {
        "" => None,
        "busy" => Some(OwnerHint::Busy),
        "idle" => Some(OwnerHint::Idle),
        "unknown" => Some(OwnerHint::Unknown),
        _ => return Err(invalid("owner_busy_hint")),
    };
    let theme = ReplyContext {
        foreground: parse_color(&request.theme_fg),
        background: parse_color(&request.theme_bg),
    };
    let now = lifecycle.host().now_ms();
    let handle = Arc::clone(lifecycle.handle());
    let mut state = lifecycle.lock();
    state.activity.set_view_state(view, now);
    state.activity.set_owner_hint(hint, now);
    state.responder.set_theme(theme);
    if request.renderer_attached {
        state.responder.attach();
    } else {
        state
            .responder
            .detach(handle.as_ref(), request.acked_sequence);
    }
    Ok(())
}

#[cfg(test)]
#[cfg(unix)]
#[path = "pty_lifecycle.tests.rs"]
mod tests;
