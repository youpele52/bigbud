use super::AgentSession;

impl AgentSession {
    pub fn is_accepting_work(&self) -> bool {
        self.accepting_work
    }

    pub fn stop_accepting_work(&mut self) {
        self.accepting_work = false;
    }

    /// Fences admission, then requests shutdown through each owned resource path.
    pub fn interrupt_owned_work_for_restart(&mut self) -> RestartShutdownEvidence {
        self.stop_accepting_work();
        let mut evidence = RestartShutdownEvidence::default();
        for cancellation in self.process_cancellations.values() {
            cancellation.store(true, std::sync::atomic::Ordering::Release);
            evidence.process_cancellations += 1;
        }
        for session in self.pty_sessions.values() {
            match session.handle.signal("SIGTERM") {
                Ok(()) => evidence.pty_shutdowns += 1,
                Err(_) => evidence.pty_failures += 1,
            }
        }
        evidence
    }

    pub fn restart_work_idle(&mut self) -> bool {
        self.restart_work_idle_inner()
    }

    pub fn force_restart_work(&mut self) {
        for session in self.pty_sessions.values() {
            if !session.handle.child_reaped() {
                let _ = session.handle.force_kill();
            }
        }
    }

    fn restart_work_idle_inner(&mut self) -> bool {
        let process_idle = !self.process_operations.has_live_operations();
        let pty_idle = self
            .pty_sessions
            .values()
            .all(|session| session.handle.native_settled());
        #[cfg(unix)]
        let pty_idle = pty_idle && crate::pty::pending_cleanup_settled();
        process_idle && pty_idle
    }

    pub fn retirement_identity_matches(&self, expected_epoch: &str, expected_digest: &str) -> bool {
        self.agent_epoch == expected_epoch && crate::identity::build_digest() == expected_digest
    }

    pub fn is_idle_for_retirement(&mut self) -> bool {
        let process_idle = !self.process_operations.has_live_operations();
        let pty_idle = self
            .pty_sessions
            .values()
            .all(|session| session.handle.native_settled());
        #[cfg(unix)]
        let pty_idle = pty_idle && crate::pty::pending_cleanup_settled();
        process_idle && pty_idle
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RestartShutdownEvidence {
    pub process_cancellations: usize,
    pub pty_shutdowns: usize,
    pub pty_failures: usize,
}
