#![allow(clippy::unwrap_used, clippy::panic)] // Private test fixtures only.
use super::support::{LIMIT, until};
use crate::{
    guard::{ControllingLock, LockError},
    owner::private_bootstrap::dummy_fixture,
};
use std::{
    fs,
    io::{self, Read},
    os::unix::fs::MetadataExt,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

pub(super) fn run() {
    // Standalone --ignored without the parent fixture sentinel is inert.
    if std::env::var("BIGBUD_APPROVED_DUMMY").as_deref() != Ok("private-fixture-v1") {
        return;
    }
    let root = PathBuf::from(std::env::var_os("BIGBUD_DUMMY_ROOT").unwrap());
    assert!(root.is_absolute());
    let metadata = fs::symlink_metadata(&root).unwrap();
    assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
    // SAFETY: no pointer input or ownership effect, read own effective UID only.
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.mode() & 0o777, 0o700);
    let mode = std::env::var("BIGBUD_DUMMY_MODE").unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    if mode == "ignore-term" {
        // SAFETY: SIG_IGN is the documented special disposition, not a Rust
        // signal handler. Only this isolated single-purpose dummy is affected.
        assert_ne!(
            unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) },
            libc::SIG_ERR
        );
    }
    if mode.starts_with("election-") {
        let elected = ControllingLock::acquire_in_verified_directory(&root);
        if mode == "election-conflict" {
            assert!(matches!(elected, Err(LockError::Conflict)));
            fs::write(root.join("conflict"), b"ok").unwrap();
        } else {
            assert!(elected.is_ok());
            fs::write(root.join("elected"), b"ok").unwrap();
        }
        return;
    }
    if mode == "bootstrap" {
        let mut stream = dummy_fixture::child_connect(end).unwrap();
        stream.set_nonblocking(true).unwrap();
        fs::write(root.join("courier-closed"), b"ok").unwrap();
        fs::write(root.join("ready"), b"ok").unwrap();
        // The post-exec stream has verified the kernel parent before disclosure;
        // it is NOT claimed to be reciprocal authenticated guard capability.
        until(end, || match stream.read(&mut [0; 1]) {
            Ok(0) => true,
            Ok(_) => panic!("unexpected dummy lifeline data"),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => false,
            Err(error) => panic!("dummy lifeline: {}", error.kind()),
        });
        fs::write(root.join("parent-eof"), b"ok").unwrap();
        return;
    }
    if mode == "helper" {
        // Exactly one first-party same-group member, never detached (no
        // setsid/setpgid) and never waited: it outlives this leader on purpose.
        let mut member = std::process::Command::new(std::env::current_exe().unwrap());
        member
            .args(["--exact", "physical::dummy_entry", "--ignored"])
            .args(["--test-threads=1"])
            .env("BIGBUD_DUMMY_MODE", "member")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // Intentional: this leader exits first; launchd adopts and reaps it.
        #[allow(clippy::zombie_processes)]
        let _unwaited_member = member.spawn().unwrap();
        until(end, || root.join("member-ready").exists());
    }
    if mode == "member" {
        fs::write(root.join("member-ready"), b"ok").unwrap();
        while Instant::now() < end {
            thread::sleep(Duration::from_millis(5));
        }
        return;
    }
    assert!(["term", "ignore-term", "exit", "helper"].contains(&mode.as_str()));
    fs::write(root.join("ready"), b"ok").unwrap();
    while Instant::now() < end {
        if ["exit", "helper"].contains(&mode.as_str()) && root.join("exit").exists() {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    assert!(end.elapsed() < LIMIT); // finite self-deadline, no daemon or descendant
}
