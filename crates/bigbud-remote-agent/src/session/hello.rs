use super::*;

impl AgentSession {
    pub(super) fn handle_client_hello(
        &mut self,
        hello: v1::ClientHello,
    ) -> Result<v1::Frame, SessionError> {
        if hello.protocol_major != PROTOCOL_MAJOR {
            return Err(SessionError::UnsupportedProtocolMajor {
                actual: hello.protocol_major,
                supported: PROTOCOL_MAJOR,
            });
        }
        if hello.client_instance_id.is_empty() {
            return Err(SessionError::MissingClientInstanceId);
        }

        self.ready = true;
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::AgentHello(v1::AgentHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                agent_version: crate::identity::build_version().to_owned(),
                build_digest: crate::identity::build_digest().to_owned(),
                os: std::env::consts::OS.to_owned(),
                architecture: std::env::consts::ARCH.to_owned(),
                agent_instance_id: self.agent_instance_id.clone(),
                agent_epoch: self.agent_epoch.clone(),
                capabilities: [
                    ("diagnostic", 1),
                    ("workspace.files", 1),
                    ("workspace.search", 1),
                    ("workspace.write", 1),
                    ("workspace.watch", 1),
                    ("process.run", 1),
                    ("process.attach", 1),
                    ("terminal.pty", 1),
                    ("supervisor.shutdown", 1),
                    ("supervisor.restart", 1),
                ]
                .into_iter()
                .map(|(name, major)| v1::Capability {
                    name: name.to_owned(),
                    major,
                    minor: 0,
                })
                .collect(),
                max_frame_bytes: bigbud_protocol::DEFAULT_MAX_FRAME_BYTES as u64,
                max_operation_output_bytes: 8 * 1024 * 1024,
                max_journal_bytes: 64 * 1024 * 1024,
            })),
        })
    }
}
