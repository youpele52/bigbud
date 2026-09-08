use std::time::Instant;

use super::AgentSession;

impl AgentSession {
    pub fn retirement_identity_matches(&self, expected_epoch: &str, expected_digest: &str) -> bool {
        self.agent_epoch == expected_epoch && crate::identity::build_digest() == expected_digest
    }

    pub fn is_idle_for_retirement(&mut self) -> bool {
        let process_idle = !self.process_operations.has_live_operations(Instant::now());
        let pty_idle = self.pty_sessions.values().all(|session| {
            session
                .handle
                .snapshot()
                .map(|snapshot| snapshot.state != crate::pty::PtyState::Running)
                .unwrap_or(false)
        });
        process_idle && pty_idle
    }
}
