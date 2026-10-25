use super::*;

pub struct PreparedPtyControl {
    handle: Arc<pty::PtyHandle>,
    payload: v1::frame::Payload,
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
        let handle = self.pty_operation_handle(id)?;
        Ok(PreparedPtyControl { handle, payload })
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
        let h = &self.handle;
        let (request_id, id, result, code, kind) = match self.payload {
            v1::frame::Payload::PtyInput(value) => (
                value.request_id,
                value.pty_id,
                h.write_input(value.sequence, &value.bytes).map(|_| ()),
                "PTY_INPUT_ERROR",
                "input",
            ),
            v1::frame::Payload::PtyOutputAck(value) => (
                value.request_id,
                value.pty_id,
                h.acknowledge(value.acknowledged_sequence),
                "PTY_ACK_ERROR",
                "ack",
            ),
            v1::frame::Payload::PtyResizeRequest(value) => (
                value.request_id,
                value.pty_id,
                h.resize(
                    value.cols.clamp(1, 500) as u16,
                    value.rows.clamp(1, 500) as u16,
                ),
                "PTY_RESIZE_ERROR",
                "resize",
            ),
            v1::frame::Payload::PtySignalRequest(value) => (
                value.request_id,
                value.pty_id,
                h.signal(&value.signal),
                "PTY_SIGNAL_ERROR",
                "signal",
            ),
            v1::frame::Payload::PtyCloseRequest(value) => (
                value.request_id,
                value.pty_id,
                h.close(value.terminate),
                "PTY_CLOSE_ERROR",
                "close",
            ),
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
