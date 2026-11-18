//! Real Linux original-child/monitor proof; not a systemd/cgroup qualification.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use bigbud_remote_agent::service_lease::{
    Binding, Controller, Error, Launch, LeaseOwner, SecretEnvironment, State,
};
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
struct Fixture {
    root: PathBuf,
    executable: PathBuf,
    digest: [u8; 32],
}
impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-service-lease-{label}-{}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let executable = root.join("shell");
        std::fs::copy("/bin/sh", &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let digest = Sha256::digest(std::fs::read(&executable).unwrap()).into();
        Self {
            root,
            executable,
            digest,
        }
    }
    fn owner(&self) -> LeaseOwner {
        LeaseOwner::with_monitor(
            std::env::var_os("BIGBUD_SERVICE_LEASE_TEST_BINARY")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_bigbud-remote-agent"))),
            "epoch".into(),
        )
        .unwrap()
    }
    fn binding(&self) -> Binding {
        Binding {
            authority: "a".repeat(32),
            installation: format!("sha256:{}", "b".repeat(64)),
            native_epoch: "epoch".into(),
            nonce: "original-nonce".into(),
            publication_sha256: [1; 32],
            executable_sha256: self.digest,
            assets_sha256: [2; 32],
            configuration_sha256: [3; 32],
            guard_sha256: [0; 32],
        }
    }
    fn launch(&self, script: &str) -> Launch {
        Launch {
            executable: self.executable.clone(),
            args: vec!["-c".into(), script.into()],
            guard: None,
            assets: None,
            environment: SecretEnvironment(vec![
                ("LEASE_SECRET".into(), "private-memory-credential".into()),
                ("PATH".into(), "/usr/bin:/bin".into()),
                (
                    "SENTINEL".into(),
                    self.root.join("sentinel").to_str().unwrap().into(),
                ),
            ]),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
fn wait_missing(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Path::new(&format!("/proc/{pid}")).exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "original child must be fully reaped"
    );
}
#[test]
fn duplicate_start_detach_secret_handoff_and_original_stop() {
    let f = Fixture::new("detach");
    let mut owner = f.owner();
    let binding = f.binding();
    let controller = Controller::current().unwrap();
    let script = "while IFS= read -r line; do :; done";
    let first = owner
        .start(
            binding.clone(),
            controller.clone(),
            &[7; 32],
            f.launch(script),
        )
        .unwrap();
    let again = owner
        .start(
            binding.clone(),
            controller.clone(),
            &[7; 32],
            f.launch(script),
        )
        .unwrap();
    assert_eq!(
        first.snapshot.original_child_pid,
        again.snapshot.original_child_pid
    );
    assert_eq!(first.generation(), again.generation());
    assert!(matches!(
        owner.start(
            binding.clone(),
            controller.clone(),
            &[7; 32],
            f.launch("exit 1")
        ),
        Err(Error::Occupied)
    ));
    assert!(matches!(
        owner.start(
            binding.clone(),
            controller.clone(),
            &[8; 32],
            f.launch(script)
        ),
        Err(Error::Occupied)
    ));
    assert_eq!(
        owner
            .with_bootstrap(first.generation(), |env| env.0.first().unwrap().1.clone())
            .unwrap(),
        "private-memory-credential"
    );
    assert!(!format!("{:?}", owner.status().unwrap()).contains("private-memory"));
    owner.detach(first.generation()).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(owner.status().unwrap().state, State::Spawned);
    assert!(owner.with_bootstrap(first.generation(), |_| ()).is_err());
    assert!(owner.with_bootstrap(first.generation(), |_| ()).is_err());
    // A live previous controller cannot use detach as a takeover shortcut.
    assert!(
        owner
            .resume(&binding, &[7; 32], controller.clone())
            .is_err()
    );
    drop(owner); // Native owner shutdown closes only its original monitor channel.
    wait_missing(first.snapshot.original_child_pid);
    assert_eq!(
        std::fs::read_dir(&f.root).unwrap().count(),
        1,
        "no bootstrap/journal file is written"
    );
}
#[test]
fn resume_requires_old_kernel_identity_dead_and_fences_old_grant() {
    let f = Fixture::new("resume");
    let mut old = Command::new("/bin/sleep")
        .arg("20")
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    let old_identity = Controller {
        pid: old.id(),
        ..Controller::current().unwrap()
    };
    // Obtain actual kernel ticks for the separate original controller via /proc.
    let stat = std::fs::read_to_string(format!("/proc/{}/stat", old.id())).unwrap();
    let start = stat
        .rsplit_once(") ")
        .unwrap()
        .1
        .split_whitespace()
        .nth(19)
        .unwrap()
        .to_owned();
    let old_identity = Controller {
        started: start,
        ..old_identity
    };
    let mut owner = f.owner();
    let binding = f.binding();
    let first = owner
        .start(
            binding.clone(),
            old_identity,
            &[7; 32],
            f.launch("while IFS= read -r line; do :; done"),
        )
        .unwrap();
    let current = Controller::current().unwrap();
    assert!(owner.resume(&binding, &[7; 32], current.clone()).is_err());
    assert!(owner.stop_original(&binding, &[7; 32], &current).is_err());
    old.kill().unwrap();
    old.wait().unwrap();
    let mut changed = binding.clone();
    changed.native_epoch = "other".into();
    assert!(owner.resume(&changed, &[7; 32], current.clone()).is_err());
    changed = binding.clone();
    changed.assets_sha256 = [9; 32];
    assert!(owner.resume(&changed, &[7; 32], current.clone()).is_err());
    assert!(owner.resume(&binding, &[8; 32], current.clone()).is_err());
    let resumed = owner.resume(&binding, &[7; 32], current).unwrap();
    assert_eq!(
        resumed.snapshot.original_child_pid,
        first.snapshot.original_child_pid
    );
    assert_ne!(resumed.generation(), first.generation());
    assert!(
        owner
            .revoke(
                &binding,
                &[7; 32],
                &Controller::current().unwrap(),
                first.generation()
            )
            .is_err()
    );
    assert_eq!(
        owner
            .revoke(
                &binding,
                &[7; 32],
                &Controller::current().unwrap(),
                resumed.generation()
            )
            .unwrap()
            .state,
        State::Exited
    );
    wait_missing(first.snapshot.original_child_pid);
    assert!(
        owner
            .start(
                binding,
                Controller::current().unwrap(),
                &[7; 32],
                f.launch("exit 0")
            )
            .is_err()
    );
}
#[test]
fn confirmed_stop_reaps_held_descendants_and_active_late_forks() {
    let f = Fixture::new("forks");
    let mut owner = f.owner();
    let script = "(while :; do (sleep .1; printf late >> \"$SENTINEL\") & sleep .01; done) & while IFS= read -r line; do :; done";
    let first = owner
        .start(
            f.binding(),
            Controller::current().unwrap(),
            &[7; 32],
            f.launch(script),
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(60));
    owner
        .revoke(
            &f.binding(),
            &[7; 32],
            &Controller::current().unwrap(),
            first.generation(),
        )
        .unwrap();
    let sentinel = f.root.join("sentinel");
    let before = std::fs::read(&sentinel).unwrap_or_default();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        std::fs::read(&sentinel).unwrap_or_default(),
        before,
        "no late descendants may write after confirmed stop"
    );
    wait_missing(first.snapshot.original_child_pid);
}

#[test]
fn unknown_monitor_receipt_retains_capacity_and_never_returns_bootstrap() {
    let f = Fixture::new("unknown");
    // Trusted embedding fault injection: this original process cannot issue a
    // native launch/exit receipt. No gateway work is claimed to have happened.
    let mut owner = LeaseOwner::with_monitor(PathBuf::from("/bin/false"), "epoch".into()).unwrap();
    assert!(matches!(
        owner.start(
            f.binding(),
            Controller::current().unwrap(),
            &[7; 32],
            f.launch("printf forbidden > \"$SENTINEL\"")
        ),
        Err(Error::Uncertain)
    ));
    assert_eq!(owner.status().unwrap().state, State::Uncertain);
    let mut other = f.binding();
    other.nonce = "different-attempt".into();
    assert!(matches!(
        owner.start(
            other,
            Controller::current().unwrap(),
            &[7; 32],
            f.launch("exit 0")
        ),
        Err(Error::Occupied)
    ));
    assert!(!f.root.join("sentinel").exists());
}

#[test]
fn detached_explicit_revoke_requires_original_binding_capability_and_grant() {
    let f = Fixture::new("detached-revoke");
    let mut owner = f.owner();
    let binding = f.binding();
    let controller = Controller::current().unwrap();
    let grant = owner
        .start(
            binding.clone(),
            controller.clone(),
            &[7; 32],
            f.launch("while IFS= read -r line; do :; done"),
        )
        .unwrap();
    owner.detach(grant.generation()).unwrap();
    assert!(
        owner
            .revoke(&binding, &[8; 32], &controller, grant.generation())
            .is_err()
    );
    let mut wrong = binding.clone();
    wrong.assets_sha256 = [9; 32];
    assert!(
        owner
            .revoke(&wrong, &[7; 32], &controller, grant.generation())
            .is_err()
    );
    assert!(owner.with_bootstrap(grant.generation(), |_| ()).is_err());
    assert_eq!(
        owner
            .revoke(&binding, &[7; 32], &controller, grant.generation())
            .unwrap()
            .state,
        State::Exited
    );
    wait_missing(grant.snapshot.original_child_pid);
}

#[test]
fn teardown_only_original_scope_requires_exact_binding_and_retains_exit_attestation() {
    let f = Fixture::new("original-scope");
    let mut owner = f.owner();
    let binding = f.binding();
    let controller = Controller::current().unwrap();
    assert!(matches!(
        owner.stop_original(&binding, &[7; 32], &controller),
        Err(Error::Uncertain)
    ));
    let first = owner
        .start(
            binding.clone(),
            controller.clone(),
            &[7; 32],
            f.launch("while IFS= read -r line; do :; done"),
        )
        .unwrap();
    owner.detach(first.generation()).unwrap();
    assert!(
        owner
            .stop_original(&binding, &[8; 32], &controller)
            .is_err()
    );
    let mut wrong = binding.clone();
    wrong.assets_sha256 = [9; 32];
    assert!(owner.stop_original(&wrong, &[7; 32], &controller).is_err());
    let exited = owner
        .stop_original(&binding, &[7; 32], &controller)
        .unwrap();
    assert_eq!(exited.state, State::Exited);
    wait_missing(first.snapshot.original_child_pid);
    assert_eq!(
        owner
            .stop_original(&binding, &[7; 32], &controller)
            .unwrap(),
        exited
    );
    assert!(
        owner
            .stop_original(&binding, &[8; 32], &controller)
            .is_err()
    );
}
