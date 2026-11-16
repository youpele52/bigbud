//! Native guard, independent of the backend/controller connection.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
use bigbud_remote_agent::service_lease::{
    Binding, Controller, Grant, Guard, Launch, LeaseOwner, SecretEnvironment, State,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-lease-guard-process-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            root: std::fs::canonicalize(root).unwrap(),
        }
    }
    fn write(&self, enabled: bool, connection: &str) {
        let next = self.root.join("next");
        std::fs::write(
            &next,
            serde_json::to_vec(&json!({"consent":enabled,"connection":connection})).unwrap(),
        )
        .unwrap();
        std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::rename(next, self.root.join("registry.json")).unwrap();
    }
    fn guard(&self) -> Guard {
        let m = std::fs::metadata(&self.root).unwrap();
        Guard::parse(&serde_json::to_vec(&json!({"version":1,"file":self.root.join("registry.json"),
   "anchors":[{"path":self.root,"dev":m.dev().to_string(),"ino":m.ino().to_string(),"uid":m.uid().to_string(),"mode":448}],
   "all":[{"path":["consent"],"values":[true]}],"select":[]})).unwrap()).unwrap()
    }
    fn running(&self) -> (LeaseOwner, Binding, Grant) {
        let executable = self.root.join("shell");
        std::fs::copy("/bin/sh", &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let digest: [u8; 32] = Sha256::digest(std::fs::read(&executable).unwrap()).into();
        let guard = self.guard();
        let binding = Binding {
            authority: "a".repeat(32),
            installation: format!("sha256:{}", "b".repeat(64)),
            native_epoch: "epoch".into(),
            nonce: "guard-original".into(),
            publication_sha256: [1; 32],
            executable_sha256: digest,
            assets_sha256: [2; 32],
            configuration_sha256: [3; 32],
            guard_sha256: guard.digest(),
        };
        let monitor = std::env::var_os("BIGBUD_SERVICE_LEASE_TEST_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_bigbud-remote-agent")));
        let mut owner = LeaseOwner::with_monitor(monitor, "epoch".into()).unwrap();
        let grant = owner
            .start(
                binding.clone(),
                Controller::current().unwrap(),
                &[7; 32],
                Launch {
                    executable,
                    args: vec!["-c".into(), "while IFS= read -r line; do :; done".into()],
                    environment: SecretEnvironment(vec![]),
                    guard: Some(guard),
                    assets: None,
                },
            )
            .unwrap();
        (owner, binding, grant)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn durable_off_stops_detached_original_child_without_a_stop_frame() {
    let f = Fixture::new();
    f.write(true, "before");
    let (mut owner, _binding, grant) = f.running();
    owner.detach(grant.generation()).unwrap();
    f.write(true, "rebound");
    std::thread::sleep(Duration::from_millis(1250));
    assert_eq!(
        owner.status().unwrap().state,
        State::Spawned,
        "unrelated registry changes must preserve native lifetime"
    );
    f.write(false, "backend-gone-before-stop");
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        if owner.status().unwrap().state == State::Exited {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "durable off must stop without a Node Stop request"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!Path::new(&format!("/proc/{}", grant.snapshot.original_child_pid)).exists());
}

#[test]
fn durable_off_cannot_return_bootstrap_even_before_the_next_periodic_poll() {
    let f = Fixture::new();
    f.write(true, "initial");
    let (mut owner, binding, grant) = f.running();
    f.write(false, "off-before-resume");
    assert!(
        owner
            .resume(&binding, &[7; 32], Controller::current().unwrap())
            .is_err()
    );
    assert!(owner.with_bootstrap(grant.generation(), |_| ()).is_err());
    assert_eq!(
        owner
            .stop_original(&binding, &[7; 32], &Controller::current().unwrap())
            .unwrap()
            .state,
        State::Exited
    );
}
