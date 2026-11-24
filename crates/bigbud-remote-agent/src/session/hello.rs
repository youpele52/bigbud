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
        let (process_id, process_start_time_ms) = process_identity::current();
        let mut capabilities = self.base_capabilities();
        capabilities.extend(self.lifecycle_capabilities());
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
                capabilities,
                max_frame_bytes: bigbud_protocol::DEFAULT_MAX_FRAME_BYTES as u64,
                max_operation_output_bytes: 8 * 1024 * 1024,
                max_journal_bytes: 64 * 1024 * 1024,
                // §7.3 item 3: lets the desktop verify a PID before ever signalling it.
                process_id,
                process_start_time_ms,
            })),
        })
    }

    fn base_capabilities(&self) -> Vec<v1::Capability> {
        [
            ("diagnostic", 1),
            ("workspace.files", 1),
            ("workspace.search", 1),
            ("workspace.search-stream", 1),
            ("os-index.search", 1),
            ("workspace.write", 1),
            ("workspace.write-create-only", 1),
            ("workspace.watch", 1),
            ("process.run", 1),
            ("process.attach", 1),
            ("terminal.pty", 1),
            ("terminal.pty-inventory", 1),
            ("terminal.pty-input-reconcile", 1),
            ("terminal.shell-profiles", 1),
            ("terminal.paste-staging", 1),
            ("supervisor.shutdown", 1),
            ("supervisor.restart", 1),
            ("service.lease", 1),
        ]
        .into_iter()
        .filter(|(name, _)| {
            (*name != "terminal.pty-input-reconcile" || cfg!(unix))
                && (*name != "terminal.paste-staging" || self.has_paste_staging())
                && (*name != "os-index.search" || self.has_os_index())
                && (*name != "service.lease" || self.has_managed_service_account())
        })
        .map(|(name, major)| v1::Capability {
            name: name.to_owned(),
            major,
            minor: match name {
                // 1.2 adds computed guard-v2 bindings and post-request refresh.
                "service.lease" => 2,
                // 1.1 reports the written content's SHA-256 on every successful write;
                // 1.2 adds the write receipt query.
                "workspace.write" => 2,
                _ => 0,
            },
        })
        .collect()
    }

    /// Protocol 1.9 terminal lifecycle capabilities, advertised only by a terminal host that
    /// implements them (plan §9.1): never by stdio agents, `terminal.spool` only with an open
    /// spool, and `terminal.local-launch` only with `--local-desktop-host`.
    fn lifecycle_capabilities(&self) -> Vec<v1::Capability> {
        use bigbud_protocol::pty_lifecycle::{
            LIFECYCLE_CAPABILITY, LOCAL_LAUNCH_CAPABILITY, QUERY_RESPONDER_CAPABILITY,
            SCREEN_CAPABILITY, SPOOL_CAPABILITY,
        };
        let Some(host) = &self.terminal_host else {
            return Vec::new();
        };
        [
            (SCREEN_CAPABILITY, true),
            (LIFECYCLE_CAPABILITY, true),
            (QUERY_RESPONDER_CAPABILITY, true),
            (SPOOL_CAPABILITY, host.spool().is_some()),
            (LOCAL_LAUNCH_CAPABILITY, host.local_desktop_host()),
        ]
        .into_iter()
        .filter(|(_, enabled)| *enabled)
        .map(|(name, _)| v1::Capability {
            name: name.to_owned(),
            major: 1,
            minor: 0,
        })
        .collect()
    }
}
