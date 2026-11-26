//! Opt-in native interoperability fixture. See protocol/ssh-owner/MANUAL-TEST.md.
//! Only three fixed loopback endpoints and built-in synthetic passwords.

use super::*;
use crate::windows_owner_pipe::{PipeName, random_token};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::windows::io::{AsHandle, FromRawHandle, OwnedHandle},
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::ERROR_FILE_NOT_FOUND,
    Storage::FileSystem::SYNCHRONIZE,
    System::{
        Pipes::WaitNamedPipeW,
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

const TARGET: TargetGeneration<'static> = TargetGeneration {
    target: "s2-inbox-password-fixture",
    generation: 1,
};
const PASSWORD_PORT: u16 = 22420;
const NONE_PORT: u16 = 22421;
const INTERACTIVE_PORT: u16 = 22422;
const USER: &str = "bb_s2_password";
const EMPTY_USER: &str = "bb_s2_empty";
const WRONG_PASSWORD: &[u8] = b"public-synthetic-windows-incorrect-fixture";
const REAP: Duration = Duration::from_secs(5);
const SSH_FAILURE: u32 = 255;

#[test]
#[ignore = "requires an approved Windows inbox guest and disposable loopback sshd fixture"]
fn native_inbox_password_qualification() {
    let fixture = Fixture::load();

    // First run the unchanged launch recipe; then isolate the intended trigger
    // (Win10 legacy DISPLAY without REQUIRE, or Win11 force without DISPLAY).
    for (label, omit) in [
        ("default recipe", None),
        ("isolated trigger", Some(fixture.omit)),
    ] {
        let (_pin, mut completion) = fixture.start(PASSWORD_PORT, USER, &fixture.pin, omit);
        let pipe = pipe_of(&completion);
        completion.deliver_fixture(TARGET, IO_BUDGET).expect(label);
        assert!(
            completion.finish(TARGET, REAP),
            "{label}: no same-child authenticated completion"
        );
        assert_pipe_removed(&pipe);
        println!("PASS: {label}: one verified helper receipt and same inbox child exit 0");
    }

    let (_pin, mut wrong) = fixture.start(PASSWORD_PORT, USER, &fixture.pin, None);
    let pipe = pipe_of(&wrong);
    wrong
        .deliver_synthetic(TARGET, IO_BUDGET, WRONG_PASSWORD)
        .unwrap();
    assert_eq!(child_of(&wrong).wait_for_exit(REAP).unwrap(), SSH_FAILURE);
    assert!(!wrong.finish(TARGET, REAP));
    assert_pipe_removed(&pipe);
    println!("PASS: wrong synthetic password delivered once, rejected by server");

    for (label, port, user, pin, exit) in [
        (
            "silent none authentication",
            NONE_PORT,
            EMPTY_USER,
            &fixture.pin,
            0,
        ),
        (
            "keyboard-interactive-only role",
            INTERACTIVE_PORT,
            USER,
            &fixture.pin,
            SSH_FAILURE,
        ),
        (
            "wrong host key",
            PASSWORD_PORT,
            USER,
            &fixture.wrong_pin,
            SSH_FAILURE,
        ),
    ] {
        let (_pin, mut completion) = fixture.start(port, user, pin, None);
        let pipe = pipe_of(&completion);
        // Observe the endpoint directly: the safe public receive() revokes if
        // SSH already exited, which could hide whether a request ever arrived.
        let error = completion
            .probe
            .endpoint
            .as_mut()
            .unwrap()
            .pipe
            .observe_connection(IO_BUDGET)
            .expect_err("unexpected helper connection");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut, "{label}");
        // SSH must already have exited inside the quiet observation window;
        // otherwise a late prompt is not ruled out. This wait cannot kill it.
        assert_eq!(
            child_of(&completion).wait_for_exit(Duration::ZERO).unwrap(),
            exit,
            "{label}"
        );
        assert!(!completion.finish(TARGET, REAP), "{label}");
        assert_pipe_removed(&pipe);
        println!("PASS: {label}: no helper request or eligibility; expected SSH exit");
    }

    let (_pin, mut cancelled) = fixture.start(PASSWORD_PORT, USER, &fixture.pin, None);
    let pipe = pipe_of(&cancelled);
    let ssh = child_of(&cancelled).clone_process().unwrap();
    let prompt = cancelled.probe.receive(TARGET, IO_BUDGET).unwrap();
    let helper = prompt.reply.request.clone_helper_process().unwrap();
    drop(prompt); // Cancel the admitted prompt without releasing any bytes.
    cancelled.probe.revoke();
    assert_ne!(spawn::wait_for_exit(&ssh, REAP).unwrap(), 0);
    assert_ne!(spawn::wait_for_exit(&helper, REAP).unwrap(), 0);
    assert!(!cancelled.finish(TARGET, REAP));
    assert_pipe_removed(&pipe);
    println!("PASS: cancellation: retained inbox child and verified helper reaped; pipe removed");
}

struct Fixture {
    root: PathBuf,
    helper: PathBuf,
    _directory_guard: GuardedLocalFile,
    ssh_sha: [u8; 32],
    helper_sha: [u8; 32],
    pin: String,
    wrong_pin: String,
    omit: &'static str,
}

impl Fixture {
    fn load() -> Self {
        let root = PathBuf::from(setting("BIGBUD_S2_FIXTURE_DIR"));
        // Hold the staged helper and its non-reparse ancestors before writing
        // any fixture pin, not only when the launcher opens that pin later.
        let helper = root.join("bigbud-ssh-password-helper.exe");
        let directory_guard = GuardedLocalPath::new(&helper)
            .and_then(|path| path.open(false))
            .expect("helper must be staged under a short ordinary local fixture path");
        let pin = setting("BIGBUD_S2_HOST_PIN");
        let wrong_pin = setting("BIGBUD_S2_WRONG_HOST_PIN");
        assert!(
            pin != wrong_pin,
            "wrong key must differ from approved fixture key"
        );
        // Validate both pins before writing either to disk or connecting.
        for key in [&pin, &wrong_pin] {
            recipe::expected_record(&target(PASSWORD_PORT, USER, key)).unwrap();
        }
        Self {
            helper,
            _directory_guard: directory_guard,
            root,
            ssh_sha: digest("BIGBUD_S2_INBOX_SHA256"),
            helper_sha: digest("BIGBUD_S2_HELPER_SHA256"),
            pin,
            wrong_pin,
            omit: match setting("BIGBUD_S2_ASKPASS_TRIGGER").as_str() {
                "legacy" => "SSH_ASKPASS_REQUIRE",
                "force" => "DISPLAY",
                _ => panic!("BIGBUD_S2_ASKPASS_TRIGGER must be legacy or force"),
            },
        }
    }

    fn start<'a>(
        &self,
        port: u16,
        user: &'a str,
        pin: &'a str,
        omit: Option<&'static str>,
    ) -> (TemporaryPin, SyntheticCompletion<'a>) {
        let target = target(port, user, pin);
        let trust = TemporaryPin::create(&self.root, &target);
        let plan = PasswordProbePlan::prepare(
            owner(),
            target,
            PasswordProbeFiles {
                inbox_ssh_sha256: self.ssh_sha,
                helper_image: &self.helper,
                helper_sha256: self.helper_sha,
                known_hosts: &trust.0,
            },
        )
        .expect("verify fixture inbox/helper images and exact Ed25519 pin");
        let mut plan = plan;
        plan.recipe.omit_askpass_trigger = omit;
        let probe = PasswordUnlockProbe::launch(TARGET, plan).expect("launch pinned inbox child");
        // Bind the pin first at every call site so it drops after native teardown.
        (trust, SyntheticCompletion::begin(probe).unwrap())
    }
}

fn target<'a>(port: u16, user: &'a str, pin: &'a str) -> LoopbackPasswordTarget<'a> {
    LoopbackPasswordTarget {
        generation: TARGET,
        port,
        user,
        approved_ed25519: pin,
    }
}

fn owner() -> ExpectedPipePeer {
    let image = GuardedLocalPath::new(&std::env::current_exe().unwrap())
        .unwrap()
        .open(false)
        .unwrap();
    // SAFETY: own a fresh least-privilege handle to this known test owner.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            std::process::id(),
        )
    };
    assert!(!raw.is_null());
    // SAFETY: successful OpenProcess transferred ownership.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    ExpectedPipePeer::from_spawned_image(handle.as_handle(), image.dos_path()).unwrap()
}

struct TemporaryPin(PathBuf);

impl TemporaryPin {
    fn create(root: &Path, target: &LoopbackPasswordTarget<'_>) -> Self {
        let nonce = u128::from_be_bytes(random_token().unwrap());
        let path = root.join(format!("known-hosts-{nonce:032x}"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let pin = Self(path);
        let result = file.write_all(recipe::expected_record(target).unwrap().as_bytes());
        drop(file);
        result.unwrap();
        pin
    }
}

impl Drop for TemporaryPin {
    fn drop(&mut self) {
        let result = fs::remove_file(&self.0);
        if !std::thread::panicking() {
            result.expect("remove owned temporary pin after closing its guard");
        }
    }
}

fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing fixture setting {name}"))
}

fn digest(name: &str) -> [u8; 32] {
    let text = setting(name);
    assert_eq!(text.len(), 64, "invalid fixture digest length for {name}");
    let mut out = [0; 32];
    for (byte, hex) in out.iter_mut().zip(text.as_bytes().chunks_exact(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(hex).unwrap(), 16)
            .expect("invalid fixture SHA256");
    }
    out
}

fn pipe_of(completion: &SyntheticCompletion<'_>) -> PipeName {
    completion.probe.endpoint.as_ref().unwrap().name().clone()
}

fn child_of<'a>(completion: &'a SyntheticCompletion<'_>) -> &'a spawn::Active {
    completion.probe.active.as_ref().unwrap()
}

fn assert_pipe_removed(name: &PipeName) {
    let wide: Vec<u16> = name.as_str().encode_utf16().chain(Some(0)).collect();
    // SAFETY: NUL-terminated local pipe address retained for this call. This
    // check cannot connect to the server or write to the helper endpoint.
    assert_eq!(unsafe { WaitNamedPipeW(wide.as_ptr(), 1) }, 0);
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(ERROR_FILE_NOT_FOUND as i32)
    );
}
