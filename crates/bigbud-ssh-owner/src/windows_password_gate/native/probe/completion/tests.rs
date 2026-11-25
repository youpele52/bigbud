use super::*;
use crate::windows_owner_pipe::{PipeName, helper};
use std::{
    os::windows::io::{AsHandle, FromRawHandle, OwnedHandle},
    process::{Command, Stdio},
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::SYNCHRONIZE,
    System::Threading::{GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

use super::super::tests::{STALE, TARGET, plan};

const PREFIX: &str = "windows_password_gate::native::probe::completion::tests::";
const EXIT_BUDGET: Duration = Duration::from_secs(3);
const OWNER: &str = "BIGBUD_TEST_COMPLETION_OWNER";
const DROP_REPLY: &str = "BIGBUD_TEST_COMPLETION_NO_ACK";

fn start(test: &str) -> SyntheticCompletion<'static> {
    let probe = PasswordUnlockProbe::launch(TARGET, plan(&format!("{PREFIX}{test}"))).unwrap();
    SyntheticCompletion::begin(probe).unwrap()
}

#[test]
fn one_verified_receipt_and_same_child_zero_exit_yield_synthetic_eligibility() {
    let mut probe = start("ssh_one_receipt");
    probe.deliver_fixture(TARGET, IO_BUDGET).unwrap();
    assert!(probe.finish(TARGET, EXIT_BUDGET));
}

#[test]
fn zero_exit_without_a_prompt_does_not_promote() {
    let probe = start("ssh_no_prompt");
    assert_eq!(
        probe
            .probe
            .active
            .as_ref()
            .unwrap()
            .wait_for_exit(EXIT_BUDGET)
            .unwrap(),
        0
    );
    assert!(!probe.finish(TARGET, EXIT_BUDGET));
}

#[test]
fn verified_release_is_not_enough_on_failure_unknown_or_stale_completion() {
    for (test, target, wait) in [
        ("ssh_nonzero", TARGET, EXIT_BUDGET),
        (
            "ssh_returns_no_completion",
            TARGET,
            Duration::from_millis(80),
        ),
        ("ssh_one_receipt", STALE, EXIT_BUDGET),
    ] {
        let mut probe = start(test);
        probe.deliver_fixture(TARGET, IO_BUDGET).unwrap();
        assert!(!probe.finish(target, wait));
    }
}

#[test]
fn even_a_verified_release_and_zero_exit_cannot_promote_after_expiry() {
    let mut probe = start("ssh_one_receipt");
    probe.deliver_fixture(TARGET, IO_BUDGET).unwrap();
    assert_eq!(
        probe
            .probe
            .active
            .as_ref()
            .unwrap()
            .wait_for_exit(EXIT_BUDGET)
            .unwrap(),
        0,
    );
    probe.probe.deadline = Instant::now();
    assert!(!probe.finish(TARGET, EXIT_BUDGET));
}

#[test]
fn missing_delivery_ack_and_duplicate_release_fail_closed() {
    let mut uncertain = start("ssh_helper_without_delivery_ack");
    assert!(uncertain.deliver_fixture(TARGET, IO_BUDGET).is_err());
    assert!(!uncertain.finish(TARGET, EXIT_BUDGET));

    let mut duplicate = start("ssh_one_receipt");
    duplicate.deliver_fixture(TARGET, IO_BUDGET).unwrap();
    assert!(duplicate.deliver_fixture(TARGET, IO_BUDGET).is_err());
    assert!(!duplicate.finish(TARGET, EXIT_BUDGET));
}

#[test]
fn ssh_one_receipt() {
    run_helper(false);
}

#[test]
fn ssh_nonzero() {
    assert!(!run_helper(false), "intentional synthetic child failure");
}

#[test]
fn ssh_returns_no_completion() {
    if run_helper(false) {
        // The job is revoked as soon as the parent's bounded OS wait fails.
        std::thread::sleep(Duration::from_secs(30));
    }
}

#[test]
fn ssh_helper_without_delivery_ack() {
    run_helper(true);
}

#[test]
fn ssh_no_prompt() {}

fn run_helper(drop_reply: bool) -> bool {
    let Ok(bootstrap) = std::env::var(PasswordHelperBootstrap::ENV) else {
        return false;
    };
    let (_, handle) = bootstrap.rsplit_once(':').unwrap();
    let handle = usize::from_str_radix(handle, 16).unwrap() as HANDLE;
    // SAFETY: Windows validates the bootstrap's inherited process handle.
    let owner = unsafe { GetProcessId(handle) };
    assert_ne!(owner, 0);
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("{PREFIX}helper_fixture"), "--quiet"])
        .env(OWNER, owner.to_string())
        .env(DROP_REPLY, if drop_reply { "1" } else { "0" })
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    true
}

#[test]
fn helper_fixture() {
    let Ok(owner) = std::env::var(OWNER) else {
        return;
    };
    let bootstrap = std::env::var(PasswordHelperBootstrap::ENV).unwrap();
    let (locator, _) = bootstrap.rsplit_once(':').unwrap();
    let (pipe, token) = locator.split_once(':').unwrap();
    let pipe = PipeName::parse(pipe).unwrap();
    let token = u128::from_str_radix(token, 16).unwrap().to_be_bytes();
    // This test stand-in finds its fixture owner via a test-only instruction.
    // The real pipe verifies the process object and the owner also verifies
    // the helper's exact image and lineage. This is not a native askpass test.
    // SAFETY: query-only fixture process handle; Windows validates the PID.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            owner.parse().unwrap(),
        )
    };
    assert!(!raw.is_null());
    // SAFETY: successful OpenProcess returned an owned process handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let expected =
        ExpectedPipePeer::from_spawned_image(handle.as_handle(), &std::env::current_exe().unwrap())
            .unwrap();
    let deny = std::env::var(DROP_REPLY).as_deref() == Ok("1");
    let result = helper::exchange_reply(&pipe, &expected, token, IO_BUDGET, |line| {
        assert_eq!(line.strip_suffix(b"\n"), Some(FIXTURE_PASSWORD));
        if deny { Err(denied()) } else { Ok(()) }
    });
    assert_eq!(result.is_ok(), !deny);
}
