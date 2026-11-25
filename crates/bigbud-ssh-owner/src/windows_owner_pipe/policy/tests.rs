#![allow(clippy::expect_used)]

use super::*;
use std::cell::Cell;

#[test]
fn accepts_only_our_canonical_local_namespace() {
    let local = PipeName::from_random_bytes([0xab; 16]);
    assert_eq!(
        local.as_str(),
        r"\\.\pipe\bigbud-ssh-owner-abababababababababababababababab"
    );
    assert_eq!(PipeName::parse(local.as_str()).expect("local name"), local);
    for invalid in [
        local.as_str().replacen(r"\\.", r"\\other-host", 1),
        local.as_str().replacen(r"\\.", r"\\?", 1),
        local.as_str().to_ascii_uppercase(),
        format!("{}\0", local.as_str()),
        format!("{}\\another", local.as_str()),
        format!("{PREFIX}abc"),
        format!("{PREFIX}{}", "é".repeat(16)),
    ] {
        assert_eq!(
            PipeName::parse(&invalid)
                .expect_err("invalid address")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}

#[test]
fn retries_only_to_deadline_and_clips_final_sleep() {
    let clock = Cell::new(Duration::ZERO);
    let attempts = Cell::new(0);
    let result = within(
        Duration::from_millis(25),
        || clock.get(),
        |sleep| clock.set(clock.get() + sleep),
        || {
            attempts.set(attempts.get() + 1);
            Ok(None::<()>)
        },
    );
    assert_eq!(
        result.expect_err("deadline").kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(clock.get(), Duration::from_millis(25));
    assert_eq!(attempts.get(), 3);
}

#[test]
fn drops_success_if_verification_runs_past_deadline() {
    let clock = Cell::new(Duration::ZERO);
    let dropped = Cell::new(false);
    struct Endpoint<'a>(&'a Cell<bool>);
    impl Drop for Endpoint<'_> {
        fn drop(&mut self) {
            self.0.set(true);
        }
    }
    let result = within(
        Duration::from_millis(5),
        || clock.get(),
        |_| {},
        || {
            clock.set(Duration::from_millis(5));
            Ok(Some(Endpoint(&dropped)))
        },
    );
    assert_eq!(
        result.err().expect("late result").kind(),
        io::ErrorKind::TimedOut
    );
    assert!(dropped.get());
}

#[test]
fn rejects_unbounded_waits_before_touching_the_pipe() {
    for timeout in [
        Duration::ZERO,
        MAX_WAIT + Duration::from_nanos(1),
        Duration::MAX,
    ] {
        let touched = Cell::new(false);
        let result = within(
            timeout,
            || Duration::ZERO,
            |_| {},
            || {
                touched.set(true);
                Ok(Some(()))
            },
        );
        assert_eq!(
            result.expect_err("invalid wait").kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(!touched.get());
    }
}

#[test]
fn rejects_unknown_wrong_changed_and_unverifiable_pids() {
    let queried = Cell::new(false);
    for (reported, expected) in [(0, 0), (6, 7)] {
        let error = verify_pid(reported, expected, || {
            queried.set(true);
            Ok(reported)
        })
        .expect_err("wrong PID");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }
    assert!(!queried.get());
    assert_eq!(
        verify_pid(7, 7, || Ok(0))
            .expect_err("unknown recheck")
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        verify_pid(7, 7, || Ok(8)).expect_err("changed peer").kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        verify_pid(7, 7, || Err(io::Error::from(io::ErrorKind::NotFound)))
            .expect_err("lost identity")
            .kind(),
        io::ErrorKind::NotFound
    );
    verify_pid(7, 7, || Ok(7)).expect("same verified peer");
}
