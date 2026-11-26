#![allow(clippy::expect_used)]
//! Linux-only: run the fixed INSTALL recipe under a disposable `$HOME` and
//! check that it produces the legacy managed layout.

use super::INSTALL;
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Stdio},
};

fn install(home: &Path, bytes: &[u8], sha: &str) -> std::process::Output {
    let mut child = Command::new("/bin/sh")
        .args(["-c", INSTALL, "sh", "0.9.0", sha, &bytes.len().to_string()])
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn sh");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(bytes)
        .expect("write");
    child.wait_with_output().expect("wait")
}

struct Home(std::path::PathBuf);

impl Home {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-agent-install-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir(&root).expect("home");
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o7777
}

#[test]
fn install_writes_the_legacy_managed_layout_and_is_idempotent() {
    let home = Home::new("layout");
    let bytes = b"\x7fELF agent bytes";
    let sha = format!("{:x}", Sha256::digest(bytes));
    for _ in 0..2 {
        let output = install(home.path(), bytes, &sha);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, b"installed");
    }
    let build = home.path().join(format!(".bigbud/agent/bin/0.9.0/{sha}"));
    let binary = build.join("bigbud-remote-agent");
    assert_eq!(std::fs::read(&binary).expect("binary"), bytes);
    assert_eq!(mode(&binary), 0o700);
    assert_eq!(mode(&build), 0o700);
    assert_eq!(std::fs::read_dir(&build).expect("build").count(), 1);
    assert!(!home.path().join(".bigbud/agent/bin/current").exists());
}

#[test]
fn install_refuses_bytes_that_do_not_match_the_identity() {
    let home = Home::new("tampered");
    let sha = format!("{:x}", Sha256::digest(b"other"));
    let output = install(home.path(), b"tampered", &sha);
    assert!(!output.status.success());
    let build = home.path().join(format!(".bigbud/agent/bin/0.9.0/{sha}"));
    assert!(!build.join("bigbud-remote-agent").exists());
    assert_eq!(std::fs::read_dir(&build).expect("build").count(), 0);
}
