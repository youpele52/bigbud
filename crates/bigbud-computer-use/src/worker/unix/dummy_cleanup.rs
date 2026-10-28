//! Private test target only. Not compiled into the production library.
//! Caller fixtures launch ONLY the first-party dummy, with NO descendants.
//! This is test teardown, never helper-closure/retirement/admission evidence.
use super::{AnchoredGroup, RetirementSignal};
use std::{
    io,
    process::ExitStatus,
    thread,
    time::{Duration, Instant},
};
impl AnchoredGroup {
    #[allow(dead_code)] // Only the explicitly invoked integration target calls this.
    pub(crate) fn reap_dummy_for_test(&mut self, deadline: Instant) -> io::Result<ExitStatus> {
        // Existing signal path rechecks exact creation/direct-parent/PGID while
        // retaining the sole unreaped Child. No caller PID/adoption is accepted.
        if !self.leader_exited()? {
            // A genuine WNOWAIT exit event is required to skip live inspection;
            // ECHILD/ESRCH/errors propagate without any inferred exit/reap.
            self.signal(RetirementSignal::Kill)?;
        }
        while !self.leader_exited()? {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "dummy cleanup timeout",
                ));
            }
            thread::sleep(Duration::from_millis(5));
        }
        // Only these tests know their no-descendant fixture closure. This reaps
        // just the retained direct Child, not a process group/wildcard/PID sweep.
        // WNOHANG in std's try_wait prevents an unbounded wait after observation.
        let status = self
            ._child
            .try_wait()?
            .ok_or_else(|| io::Error::other("dummy exit observation lost"))?;
        self.reaped = true;
        Ok(status)
    }
}

impl AnchoredGroup {
    #[allow(dead_code)] // Private integration assertions, not production APIs.
    pub(crate) fn dummy_signal_attempts(&self) -> usize {
        self.signal_attempts
            .load(std::sync::atomic::Ordering::SeqCst)
    }
    #[allow(dead_code)]
    pub(crate) fn reject_changed_dummy_identity(&mut self) -> io::Result<()> {
        let original = self.identity.creation.clone();
        self.identity.creation.push_str("-changed");
        let result = self.signal(RetirementSignal::Kill);
        self.identity.creation = original;
        result
    }
}
#[test]
fn absent_direct_child_event_is_error_not_exit_authority() {
    let own_pid = std::num::NonZeroU32::new(std::process::id()).unwrap();
    let error = super::observe_unreaped_child(own_pid).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::ECHILD));
}
