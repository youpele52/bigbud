use super::identity::namespace;
use super::*;
use std::{
    io::Read,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
pub(super) const SLOT: &str = "0011223344556677";

pub(super) struct Root(pub(super) PathBuf);

impl Root {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bigbud-retirement-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }

    pub(super) fn retirement(&self, auto_retire: bool) -> Retirement {
        Retirement {
            root: self.0.clone(),
            epoch: [7; 32],
            auto_retire,
        }
    }

    pub(super) fn lock(&self) -> PathBuf {
        self.0.join("owner.lock")
    }

    pub(super) fn send(&self, name: &str, record: &Record) {
        fs::write(self.0.join(name), encode(record)).unwrap();
        fs::set_permissions(self.0.join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }

    pub(super) fn send_raw(&self, name: &str, text: &str) {
        fs::write(self.0.join(name), text).unwrap();
        fs::set_permissions(self.0.join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn sleep(seconds: &str) -> Child {
    Command::new("/bin/sleep")
        .arg(seconds)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

pub(super) fn orphan_sleep() -> u32 {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "sleep 30 >/dev/null 2>&1 & echo $!"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    let pid = output.trim().parse().unwrap();
    let _ = child.wait();
    pid
}

pub(super) struct Pid(pub(super) u32);

impl Drop for Pid {
    fn drop(&mut self) {
        // SAFETY: test cleanup only; a missing PID is ignored.
        unsafe { libc::kill(self.0 as i32, libc::SIGKILL) };
    }
}

pub(super) fn child_record(kind: Kind, identity: Identity, epoch: &str) -> Record {
    Record {
        epoch: epoch.to_owned(),
        kind: Some(kind),
        state: State::Bound,
        pid: identity.pid,
        start: identity.start,
        namespace: identity.namespace,
    }
}

pub(super) fn gone_owner(epoch: &str) -> Record {
    Record {
        epoch: epoch.to_owned(),
        kind: None,
        state: State::Bound,
        pid: u32::MAX,
        start: 1,
        namespace: namespace(),
    }
}
