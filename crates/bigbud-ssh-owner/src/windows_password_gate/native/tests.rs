use super::*;
use std::{
    os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    process::{Child, Command, Stdio},
};
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    Storage::FileSystem::SYNCHRONIZE,
    System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject},
};

const FIXTURE_PASSWORD: &[u8] = b"public-synthetic-password-fixture";
const QUALIFICATION: ProbeQualification = ProbeQualification {
    dedicated_owner_probe: true,
    fresh_connection: true,
    strict_host_verification: true,
    no_master_or_agent_reuse: true,
    password_only_without_fallback: true,
};

const TARGET: TargetGeneration<'_> = TargetGeneration {
    target: "native-helper-fixture",
    generation: 1,
};
const PIPE: &str = "BIGBUD_TEST_PASSWORD_HELPER_PIPE";
const OWNER: &str = "BIGBUD_TEST_PASSWORD_HELPER_OWNER";
const TOKEN: &str = "BIGBUD_TEST_PASSWORD_HELPER_TOKEN";
const REPLY: &str = "BIGBUD_TEST_PASSWORD_HELPER_REPLY";
const SSH_FIXTURE: &str = "windows_password_gate::native::tests::ssh_fixture";
const HELPER_FIXTURE: &str = "windows_password_gate::native::tests::helper_fixture";

#[test]
fn admits_only_the_verified_ssh_childs_helper_and_only_once() {
    let image = std::env::current_exe().expect("fixture executable");
    let (mut attempt, mut endpoint, token) =
        PasswordHelperAttempt::register(TARGET, &image).expect("register before spawn");
    let owner = std::process::id();
    let mut ssh = spawn(SSH_FIXTURE, endpoint.name(), owner, token);

    // Accept an actual request from the SSH stand-in's direct child while
    // the grant is still unbound. Only the retained launch handle may bind it.
    let early = endpoint.receive(IO_BUDGET).expect("receive early request");
    let Admission::WaitForChild { request, until } = attempt.admit(TARGET, early) else {
        panic!("expected bounded early request");
    };
    assert!(until <= Instant::now() + IO_BUDGET);
    let binding = attempt
        .bind_child(TARGET, ssh.0.as_handle(), &image)
        .expect("bind verified SSH stand-in");
    // The fixture first sends a valid token. After close it replays it.
    assert!(matches!(
        attempt.admit(TARGET, request),
        Admission::Claimed { binding: actual, until: same, .. } if actual == binding && same == until
    ));
    let replay = endpoint.receive(IO_BUDGET).expect("receive replay");
    assert!(matches!(attempt.admit(TARGET, replay), Admission::Rejected));
    ssh.finish();
}

#[test]
fn wrong_lineage_and_wrong_token_leave_the_registered_claim_available() {
    let image = std::env::current_exe().expect("fixture executable");
    let (mut attempt, mut endpoint, token) =
        PasswordHelperAttempt::register(TARGET, &image).expect("register before spawn");
    let owner = std::process::id();

    // This same-image peer presents the correct token, but its actual parent
    // is the owner, not the independently retained SSH stand-in.
    let name = endpoint.name().clone();
    let mut foreign = spawn(HELPER_FIXTURE, &name, owner, token);
    let early = endpoint.receive(IO_BUDGET).expect("receive foreign peer");
    let Admission::WaitForChild { request, .. } = attempt.admit(TARGET, early) else {
        panic!("the foreign peer remains unverified before binding");
    };
    let mut ssh = spawn_ssh(&name, owner, token);
    attempt
        .bind_child(TARGET, ssh.0.as_handle(), &image)
        .expect("bind verified SSH stand-in");
    assert!(matches!(
        attempt.admit(TARGET, request),
        Admission::Rejected
    ));
    foreign.finish();

    let bad_token = endpoint.receive(IO_BUDGET).expect("receive wrong token");
    assert!(matches!(
        attempt.admit(TARGET, bad_token),
        Admission::Rejected
    ));
    let valid = endpoint.receive(IO_BUDGET).expect("receive right token");
    assert!(matches!(
        attempt.admit(TARGET, valid),
        Admission::Claimed { .. }
    ));
    ssh.finish();
}

#[test]
fn helper_checks_owner_before_writing_its_request() {
    let image = std::env::current_exe().expect("fixture executable");
    let (_, mut endpoint, token) =
        PasswordHelperAttempt::register(TARGET, &image).expect("create endpoint");
    let mut helper = Fixture(
        command(HELPER_FIXTURE, endpoint.name(), std::process::id(), token)
            .env("BIGBUD_TEST_PASSWORD_HELPER_WRONG_OWNER", "1")
            .spawn()
            .expect("start helper fixture"),
    );
    assert!(endpoint.receive(IO_BUDGET).is_err());
    helper.finish();
}

#[test]
fn sends_one_synthetic_reply_to_the_verified_helper() {
    check_fixture_reply("allow", TARGET, false, QUALIFICATION);
}

#[test]
fn does_not_send_when_the_live_generation_changes_after_admission() {
    check_fixture_reply(
        "deny",
        TargetGeneration {
            generation: TARGET.generation + 1,
            ..TARGET
        },
        false,
        QUALIFICATION,
    );
}

#[test]
fn does_not_send_after_revoke_or_without_destination_only_launch() {
    check_fixture_reply("deny", TARGET, true, QUALIFICATION);
    check_fixture_reply(
        "deny",
        TARGET,
        false,
        ProbeQualification {
            password_only_without_fallback: false,
            ..QUALIFICATION
        },
    );
}

fn check_fixture_reply(
    mode: &str,
    live_target: TargetGeneration<'_>,
    revoke: bool,
    qualification: ProbeQualification,
) {
    let image = std::env::current_exe().expect("fixture executable");
    let (mut attempt, mut endpoint, token) =
        PasswordHelperAttempt::register(TARGET, &image).expect("register fixture");
    let mut ssh = Fixture(
        command(SSH_FIXTURE, endpoint.name(), std::process::id(), token)
            .env(REPLY, mode)
            .spawn()
            .expect("start SSH stand-in"),
    );
    attempt
        .bind_child(TARGET, ssh.0.as_handle(), &image)
        .expect("bind SSH stand-in");
    let request = endpoint.receive(IO_BUDGET).expect("receive helper request");
    let Admission::Claimed { reply, .. } = attempt.admit(TARGET, request) else {
        panic!("expected verified admission");
    };
    if revoke {
        attempt.revoke();
    }
    let mut bytes = PasswordBytes::from_boxed_slice(FIXTURE_PASSWORD.into());
    let wiped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observer = wiped.clone();
    bytes.observe_wipe(move |bytes| {
        assert!(bytes.iter().all(|&byte| byte == 0));
        observer.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let result = attempt.deliver(live_target, reply, qualification, bytes);
    assert!(wiped.load(std::sync::atomic::Ordering::SeqCst));
    if mode == "allow" {
        result.expect("complete acknowledged fixture reply");
    } else {
        assert_eq!(
            result.expect_err("deny stale generation").kind(),
            io::ErrorKind::PermissionDenied
        );
    }
    ssh.finish();
}

#[test]
fn ssh_fixture() {
    let Some((pipe, owner, token)) = bootstrap() else {
        return;
    };
    if std::env::var_os(REPLY).is_some() {
        spawn(HELPER_FIXTURE, &pipe, owner, token).finish();
        return;
    }
    let mut first = token;
    if std::env::var_os("BIGBUD_TEST_PASSWORD_HELPER_WRONG_TOKEN").is_some() {
        first[0] ^= 1;
    }
    for input in [first, token] {
        // The owner authenticates the actual helper endpoint, not these
        // test-only launch inputs passed through the SSH stand-in.
        let mut helper = spawn(HELPER_FIXTURE, &pipe, owner, input);
        helper.finish();
    }
}

#[test]
fn helper_fixture() {
    let Some((pipe, owner, token)) = bootstrap() else {
        return;
    };
    let wrong_owner = std::env::var_os("BIGBUD_TEST_PASSWORD_HELPER_WRONG_OWNER").is_some();
    let pid = if wrong_owner {
        std::process::id()
    } else {
        owner
    };
    // SAFETY: query/synchronize only; this PID is a fixture instruction, not
    // a production trust bootstrap. A successful call returns a fresh handle.
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    assert!(!raw.is_null());
    // SAFETY: fresh non-null process handle owned by this fixture.
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    let expected = ExpectedPipePeer::from_spawned_image(
        process.as_handle(),
        &std::env::current_exe().expect("fixture executable"),
    )
    .expect("pin fixture owner image");
    if let Ok(mode) = std::env::var(REPLY) {
        let result = helper::exchange_reply(&pipe, &expected, token, IO_BUDGET, |line| {
            assert_eq!(mode, "allow", "a denied request reached output");
            assert_eq!(&line[..line.len() - 1], FIXTURE_PASSWORD);
            assert_eq!(line.last(), Some(&b'\n'));
            Ok(())
        });
        assert_eq!(result.is_ok(), mode == "allow");
        return;
    }
    let result = submit_helper_request(&pipe, &expected, token);
    if wrong_owner {
        assert_eq!(
            result.expect_err("cannot write to wrong owner").kind(),
            io::ErrorKind::PermissionDenied
        );
    } else {
        result.expect("submit request and observe close");
    }
}

fn command(test: &str, pipe: &PipeName, owner: u32, token: [u8; 16]) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("fixture executable"));
    command
        .args(["--exact", test])
        .env(PIPE, pipe.as_str())
        .env(OWNER, owner.to_string())
        .env(TOKEN, format!("{:032x}", u128::from_be_bytes(token)))
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    command
}

fn spawn(test: &str, pipe: &PipeName, owner: u32, token: [u8; 16]) -> Fixture {
    Fixture(
        command(test, pipe, owner, token)
            .spawn()
            .expect("start test process"),
    )
}

fn spawn_ssh(pipe: &PipeName, owner: u32, token: [u8; 16]) -> Fixture {
    Fixture(
        command(SSH_FIXTURE, pipe, owner, token)
            .env("BIGBUD_TEST_PASSWORD_HELPER_WRONG_TOKEN", "1")
            .spawn()
            .expect("start SSH stand-in"),
    )
}

fn bootstrap() -> Option<(PipeName, u32, [u8; 16])> {
    let pipe = std::env::var(PIPE).ok()?;
    let owner = std::env::var(OWNER).expect("fixture owner PID");
    let token = std::env::var(TOKEN).expect("fixture admission token");
    Some((
        PipeName::parse(&pipe).expect("fixture pipe"),
        owner.parse().expect("fixture PID"),
        u128::from_str_radix(&token, 16)
            .expect("fixture token")
            .to_be_bytes(),
    ))
}

struct Fixture(Child);

impl Fixture {
    fn finish(&mut self) {
        assert!(self.exited(5000), "fixture did not exit");
        assert!(self.0.wait().expect("reap fixture").success());
    }

    fn exited(&self, timeout_millis: u32) -> bool {
        // SAFETY: the retained child process handle remains live for this wait.
        unsafe { WaitForSingleObject(self.0.as_raw_handle(), timeout_millis) == WAIT_OBJECT_0 }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.exited(0) {
            // Best effort; any descended fixture has its own bounded pipe I/O.
            let _ = self.0.kill();
            if self.exited(2000) {
                let _ = self.0.wait();
            }
        }
    }
}
