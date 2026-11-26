use super::*;

pub struct PreparedPtyControl {
    /// `None` only for a close that dismissed a lost PTY's spool (plan §8.3).
    handle: Option<Arc<pty::PtyHandle>>,
    payload: v1::frame::Payload,
    /// Lifecycle facts to update after the control runs (input activity, applied resizes).
    lifecycle: Option<Arc<super::pty_lifecycle::PtyLifecycle>>,
}

/// A terminating close waits for its escalation (up to a few seconds); the supervisor runs it
/// off the connection's read loop.
pub fn is_blocking_pty_control(payload: &v1::frame::Payload) -> bool {
    matches!(payload, v1::frame::Payload::PtyCloseRequest(value) if value.terminate)
}

pub fn is_pty_control(payload: &v1::frame::Payload) -> bool {
    matches!(
        payload,
        v1::frame::Payload::PtyInput(_)
            | v1::frame::Payload::PtyOutputAck(_)
            | v1::frame::Payload::PtyResizeRequest(_)
            | v1::frame::Payload::PtySignalRequest(_)
            | v1::frame::Payload::PtyCloseRequest(_)
    )
}

impl AgentSession {
    /// Only resolves an owned handle under the controller lock; execution runs outside it.
    pub fn prepare_pty_control(
        &mut self,
        payload: v1::frame::Payload,
    ) -> Result<PreparedPtyControl, SessionError> {
        if !self.accepting_work && matches!(&payload, v1::frame::Payload::PtyInput(_)) {
            return Err(SessionError::Restarting);
        }
        let id = match &payload {
            v1::frame::Payload::PtyInput(value) => &value.pty_id,
            v1::frame::Payload::PtyOutputAck(value) => &value.pty_id,
            v1::frame::Payload::PtyResizeRequest(value) => &value.pty_id,
            v1::frame::Payload::PtySignalRequest(value) => &value.pty_id,
            v1::frame::Payload::PtyCloseRequest(value) => &value.pty_id,
            _ => return Err(SessionError::UnexpectedMessage),
        };
        if let v1::frame::Payload::PtyCloseRequest(close) = &payload
            && self.dismiss_lost_pty(&close.pty_id)
        {
            return Ok(PreparedPtyControl {
                handle: None,
                payload,
                lifecycle: None,
            });
        }
        let handle = Some(self.pty_operation_handle(id)?);
        let lifecycle = self
            .pty_sessions
            .get(id)
            .and_then(|session| session.lifecycle.clone());
        Ok(PreparedPtyControl {
            handle,
            payload,
            lifecycle,
        })
    }

    pub fn retain_closed_pty(&mut self, response: &v1::Frame) {
        if let Some(v1::frame::Payload::PtyCloseResponse(value)) = &response.payload
            && value.accepted
            && let Some(session) = self.pty_sessions.get_mut(&value.pty_id)
        {
            session.expires_at = Some(Instant::now() + PTY_RESULT_RETENTION);
        }
    }
}

impl PreparedPtyControl {
    pub fn execute(self) -> Result<v1::Frame, SessionError> {
        let Some(h) = &self.handle else {
            // A dismissed lost PTY: its spool is gone; the close is complete.
            return match self.payload {
                v1::frame::Payload::PtyCloseRequest(value) => Ok(pty_control_response_frame(
                    value.request_id,
                    value.pty_id,
                    Ok(()),
                    "PTY_CLOSE_ERROR",
                    "close",
                )),
                _ => Err(SessionError::UnexpectedMessage),
            };
        };
        let lifecycle = self.lifecycle.as_deref();
        let (request_id, id, result, code, kind) = match self.payload {
            v1::frame::Payload::PtyInput(value) => {
                let result = h.write_input(value.sequence, &value.bytes).map(|_| ());
                if result.is_ok()
                    && let Some(lifecycle) = lifecycle
                {
                    lifecycle.record_input();
                }
                (
                    value.request_id,
                    value.pty_id,
                    result,
                    "PTY_INPUT_ERROR",
                    "input",
                )
            }
            v1::frame::Payload::PtyOutputAck(value) => (
                value.request_id,
                value.pty_id,
                h.acknowledge(value.acknowledged_sequence),
                "PTY_ACK_ERROR",
                "ack",
            ),
            v1::frame::Payload::PtyResizeRequest(value) => {
                let (cols, rows) = (
                    value.cols.clamp(1, 500) as u16,
                    value.rows.clamp(1, 500) as u16,
                );
                let result = h.resize(cols, rows);
                if result.is_ok()
                    && let Some(lifecycle) = lifecycle
                {
                    lifecycle.resized(cols, rows);
                }
                (
                    value.request_id,
                    value.pty_id,
                    result,
                    "PTY_RESIZE_ERROR",
                    "resize",
                )
            }
            v1::frame::Payload::PtySignalRequest(value) => (
                value.request_id,
                value.pty_id,
                h.signal(&value.signal),
                "PTY_SIGNAL_ERROR",
                "signal",
            ),
            v1::frame::Payload::PtyCloseRequest(value) => {
                let result = h.close(value.terminate);
                if result.is_ok() && value.terminate {
                    // Answer only once the child is reaped, or the escalation ended; an
                    // unreaped child is then reported as `outcome-unknown` by inventory.
                    let _outcome = h.wait_closed(pty::PtyHandle::close_deadline());
                }
                (
                    value.request_id,
                    value.pty_id,
                    result,
                    "PTY_CLOSE_ERROR",
                    "close",
                )
            }
            _ => return Err(SessionError::UnexpectedMessage),
        };
        Ok(pty_control_response_frame(
            request_id,
            id,
            result.map_err(|error| SessionError::Pty(error.to_string())),
            code,
            kind,
        ))
    }
}
