//! Real Linux original-child gateway stand-in: this test binary binds loopback, prints the
//! gateway's post-bind ready line and serves until its stdin lifeline closes.
// Shared by several integration-test crates; each uses a subset.
#![allow(dead_code)]
use bigbud_remote_agent::service_lease::{
    Binding, Controller, Launch, LeaseOwner, SecretEnvironment,
};
use sha2::{Digest, Sha256};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const HELPER: &str = "gateway_stand_in_helper";
pub const HELPER_ENV: &str = "BIGBUD_RECOVERY_GATEWAY_HELPER";
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub struct Fixture {
    pub root: PathBuf,
    executable: PathBuf,
    digest: [u8; 32],
    /// The actual `bigbud-mobile-gateway` instead of this test binary's stand-in.
    real: bool,
}
impl Fixture {
    pub fn new(label: &str) -> Self {
        Self::with_executable(label, &std::env::current_exe().unwrap(), false)
    }
    pub fn gateway(label: &str, binary: &Path) -> Self {
        Self::with_executable(label, binary, true)
    }
    fn with_executable(label: &str, source: &Path, real: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-lease-recovery-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let executable = root.join("gateway");
        std::fs::copy(source, &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let digest = Sha256::digest(std::fs::read(&executable).unwrap()).into();
        Self {
            root,
            executable,
            digest,
            real,
        }
    }
    pub fn socket(&self) -> PathBuf {
        self.root.join("remote-mobile.sock")
    }
    pub fn receipts(&self) -> PathBuf {
        self.root.join("receipts")
    }
    pub fn owner(&self) -> LeaseOwner {
        LeaseOwner::with_monitor(
            PathBuf::from(env!("CARGO_BIN_EXE_bigbud-remote-agent")),
            "epoch".into(),
        )
        .unwrap()
        .with_receipts(self.receipts())
        .unwrap()
    }
    pub fn binding(&self, nonce: &str) -> Binding {
        Binding {
            authority: "a".repeat(32),
            installation: format!("sha256:{}", "b".repeat(64)),
            native_epoch: "epoch".into(),
            nonce: nonce.into(),
            publication_sha256: [1; 32],
            executable_sha256: self.digest,
            assets_sha256: [2; 32],
            configuration_sha256: [3; 32],
            guard_sha256: [0; 32],
        }
    }
    pub fn launch(&self) -> Launch {
        if self.real {
            let socket = self.socket();
            return Launch {
                executable: self.executable.clone(),
                args: [
                    "--listen",
                    "127.0.0.1:0",
                    "--upstream-unix",
                    socket.to_str().unwrap(),
                    "--external-origin",
                    "https://desk.ts.net",
                    "--stdin-lifeline",
                ]
                .map(String::from)
                .to_vec(),
                environment: SecretEnvironment(vec![(
                    "BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL".into(),
                    "c".repeat(32),
                )]),
                guard: None,
                assets: None,
            };
        }
        Launch {
            executable: self.executable.clone(),
            // libtest treats everything after `--` as name filters; only HELPER matches.
            args: [
                HELPER,
                "--exact",
                "--nocapture",
                "--test-threads=1",
                "--",
                "--listen",
                "127.0.0.1:0",
                "--upstream-unix",
                self.socket().to_str().unwrap(),
            ]
            .map(String::from)
            .to_vec(),
            environment: SecretEnvironment(vec![(HELPER_ENV.into(), "1".into())]),
            guard: None,
            assets: None,
        }
    }
    /// A sealed private upstream socket as the TypeScript listener publishes it.
    pub fn listen(&self) -> UnixListener {
        let listener = UnixListener::bind(self.socket()).unwrap();
        std::fs::set_permissions(self.socket(), std::fs::Permissions::from_mode(0o600)).unwrap();
        listener
    }
    /// A different inode published over the path while the old inode still exists.
    pub fn replace_with_unrecorded_socket(&self) {
        let other = self.root.join("other.sock");
        drop(UnixListener::bind(&other).unwrap());
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::rename(other, self.socket()).unwrap();
    }
    pub fn receipt(&self) -> Option<serde_json::Value> {
        let mut files = std::fs::read_dir(self.receipts())
            .ok()?
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert!(files.len() <= 1, "one live receipt per original attempt");
        let path = files.pop()?;
        let info = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!((info.mode() & 0o7777, info.nlink()), (0o600, 1));
        Some(serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _cleanup = std::fs::remove_dir_all(&self.root);
    }
}

/// A separate original controller whose exact kernel identity can later die.
pub fn old_controller() -> (Child, Controller) {
    let child = Command::new("/bin/sleep")
        .arg("60")
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    let stat = std::fs::read_to_string(format!("/proc/{}/stat", child.id())).unwrap();
    let started = stat
        .rsplit_once(") ")
        .unwrap()
        .1
        .split_whitespace()
        .nth(19)
        .unwrap()
        .to_owned();
    let identity = Controller {
        pid: child.id(),
        started,
        ..Controller::current().unwrap()
    };
    (child, identity)
}
pub fn kill(child: &mut Child) {
    child.kill().unwrap();
    child.wait().unwrap();
}
pub fn kill_pid(pid: u32) {
    assert!(
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
}
pub fn wait_missing(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Path::new(&format!("/proc/{pid}")).exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
}
pub fn inode(path: &Path) -> String {
    std::fs::symlink_metadata(path).unwrap().ino().to_string()
}
