use super::{
    snapshot::{Backend, sample},
    *,
};
use framework::Console;
use std::collections::VecDeque;

struct Fixture {
    accounts: VecDeque<Result<(u32, u32), SnapshotError>>,
    sessions: VecDeque<Result<(u32, u32), SnapshotError>>,
    console: Option<Result<Console, SnapshotError>>,
}
impl Fixture {
    fn good() -> Self {
        Self {
            accounts: VecDeque::from([Ok((501, 501)), Ok((501, 501))]),
            sessions: VecDeque::from([Ok((42, 0x10)), Ok((42, 0x10))]),
            console: Some(Ok(Console {
                uid: 501,
                set: 0,
                on_console: true,
                login_done: true,
            })),
        }
    }
    fn sampled() -> InteractiveSnapshot {
        sample(&mut Self::good()).unwrap()
    }
}
impl Backend for Fixture {
    fn account(&mut self) -> Result<(u32, u32), SnapshotError> {
        self.accounts.pop_front().unwrap()
    }
    fn security(&mut self) -> Result<(u32, u32), SnapshotError> {
        self.sessions.pop_front().unwrap()
    }
    fn console(&mut self) -> Result<Console, SnapshotError> {
        self.console.take().unwrap()
    }
}
#[test]
fn framework_sample_checks_accounts_session_flags_and_bracketing() {
    assert!(sample(&mut Fixture::good()).is_ok());
    for account in [(0, 0), (501, 0), (501, 502)] {
        let mut fixture = Fixture::good();
        fixture.accounts[0] = Ok(account);
        assert_eq!(sample(&mut fixture).err(), Some(SnapshotError::Account));
    }
    for session in [0, u32::MAX, u32::MAX - 1] {
        let mut fixture = Fixture::good();
        fixture.sessions[0] = Ok((session, 0x10));
        assert_eq!(sample(&mut fixture).err(), Some(SnapshotError::Malformed));
    }
    for flags in [0, 1, 0x11, 0x1010, 0x20, 0x8000] {
        let mut fixture = Fixture::good();
        fixture.sessions[0] = Ok((42, flags));
        assert!(sample(&mut fixture).is_err(), "flags {flags}");
    }
    let mut fixture = Fixture::good();
    fixture.sessions[1] = Ok((43, 0x10));
    assert_eq!(sample(&mut fixture).err(), Some(SnapshotError::Changed));
    let mut fixture = Fixture::good();
    fixture.accounts[1] = Ok((502, 502));
    assert_eq!(sample(&mut fixture).err(), Some(SnapshotError::Changed));
}
#[test]
fn every_backend_error_and_noninteractive_console_refuses() {
    for stage in 0..5 {
        let mut fixture = Fixture::good();
        match stage {
            0 => fixture.accounts[0] = Err(SnapshotError::Account),
            1 => fixture.sessions[0] = Err(SnapshotError::Security),
            2 => fixture.console = Some(Err(SnapshotError::NoGui)),
            3 => fixture.sessions[1] = Err(SnapshotError::Security),
            _ => fixture.accounts[1] = Err(SnapshotError::Account),
        }
        assert!(sample(&mut fixture).is_err());
    }
    for console in [
        Console {
            uid: 502,
            set: 0,
            on_console: true,
            login_done: true,
        },
        Console {
            uid: 501,
            set: 0,
            on_console: false,
            login_done: true,
        },
        Console {
            uid: 501,
            set: 0,
            on_console: true,
            login_done: false,
        },
    ] {
        let mut fixture = Fixture::good();
        fixture.console = Some(Ok(console));
        assert_eq!(
            sample(&mut fixture).err(),
            Some(SnapshotError::NotInteractive)
        );
    }
}
#[test]
fn recovery_binding_changes_errors_and_unlock_never_clear_denial() {
    use crate::guard::{ControllingLock, SessionInvalidationCause, test_support::TestDirectory};
    let directory = TestDirectory::new();
    let mut lock = ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    let mut recovery = lock.recover_retained();
    assert!(
        recovery
            .identity
            .observe(Ok(Fixture::sampled()), &recovery.session)
            .is_ok()
    );
    assert!(
        recovery
            .identity
            .observe(Ok(Fixture::sampled()), &recovery.session)
            .is_ok()
    );
    assert!(crate::owner::private_bootstrap::BootstrapPermit::verify().is_err());
    let mut changed = Fixture::good();
    changed.console.as_mut().unwrap().as_mut().unwrap().set = 1;
    assert_eq!(
        recovery
            .identity
            .observe(sample(&mut changed), &recovery.session),
        Err(SnapshotError::Changed)
    );
    assert_eq!(
        recovery.session_invalidation(),
        Some(SessionInvalidationCause::IdentityChanged)
    );
    assert!(
        recovery
            .identity
            .observe(Ok(Fixture::sampled()), &recovery.session)
            .is_err()
    );
    assert!(recovery.flush_session_invalidation().is_err());
    assert!(recovery.record().unwrap().latched);
    drop(recovery);
    let mut recovery = lock.recover_retained();
    assert_eq!(
        recovery
            .identity
            .observe(Err(SnapshotError::NoGui), &recovery.session),
        Err(SnapshotError::NoGui)
    );
    assert_eq!(
        recovery.session_invalidation(),
        Some(SessionInvalidationCause::ObservationLost)
    );
    assert!(
        recovery
            .identity
            .observe(Ok(Fixture::sampled()), &recovery.session)
            .is_err()
    );
}
