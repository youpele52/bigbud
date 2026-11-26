//! Production master refusal and generation tests (W3.7 providers).

use super::*;

use std::{
    fs,
    io::Write,
    net::Ipv4Addr,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

const GOOD_PIN: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
const OTHER_PIN: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB\n";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-production-master-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        write(&root.join("identity"), "synthetic identity", 0o600);
        write(
            &root.join("known_hosts"),
            &format!("[127.0.0.1]:22222 {GOOD_PIN}"),
            0o600,
        );
        Self(root)
    }

    fn transport(&self, ssh: &str) -> Transport {
        Transport::new(TransportConfig {
            ssh: ssh.into(),
            keyscan: "/usr/bin/ssh-keyscan".into(),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 22222,
            user: "tester".into(),
            identity: self.0.join("identity"),
            known_hosts: self.0.join("known_hosts"),
            alias_config: None,
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
            host_identity: Default::default(),
        })
        .unwrap()
    }

    fn known_hosts(&self) -> PathBuf {
        self.0.join("known_hosts")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write(path: &std::path::Path, contents: &str, mode: u32) {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .unwrap();
    file.write_all(contents.as_bytes()).unwrap();
}

#[test]
fn production_master_refuses_a_non_system_image_before_any_dial() {
    let fixture = Fixture::new();
    let transport = fixture.transport("/test-no-ssh");
    let mut picker = MasterPicker::production(fixture.0.clone(), None);
    assert_eq!(
        picker.list(&transport, [1; 32], None),
        Err(ErrorCode::ConfigUnsupported)
    );
    assert!(!picker.slot.has_live_master());
}

#[test]
fn production_master_refuses_a_changed_host_key_before_any_dial() {
    if !Path::new("/usr/bin/ssh").exists() {
        return;
    }
    let fixture = Fixture::new();
    let transport = fixture.transport("/usr/bin/ssh");
    // Two candidate records are a changed store, not a pin. This is read
    // before the master command is constructed or spawned.
    write(
        &fixture.known_hosts(),
        &format!("[127.0.0.1]:22222 {GOOD_PIN}[127.0.0.1]:22222 {OTHER_PIN}"),
        0o600,
    );
    let mut picker = MasterPicker::production(fixture.0.clone(), None);
    assert_eq!(
        picker.list(&transport, [1; 32], None),
        Err(ErrorCode::HostKeyChanged)
    );
    assert!(!picker.slot.has_live_master());
}

#[test]
fn production_master_requires_an_approved_pin_before_any_dial() {
    if !Path::new("/usr/bin/ssh").exists() {
        return;
    }
    let fixture = Fixture::new();
    let transport = fixture.transport("/usr/bin/ssh");
    fs::remove_file(fixture.known_hosts()).unwrap();
    let mut picker = MasterPicker::production(fixture.0.clone(), None);
    assert_eq!(
        picker.list(&transport, [1; 32], None),
        Err(ErrorCode::TrustRequired)
    );
    assert!(!picker.slot.has_live_master());
}

#[test]
fn a_stale_generation_cannot_reuse_or_retire_a_production_master() {
    let fixture = Fixture::new();
    let mut first = MasterPicker::production(fixture.0.clone(), None);
    let mut second = MasterPicker::production(fixture.0.clone(), None);
    assert_eq!(first.admit([1; 32]), Ok(()));
    assert_eq!(second.admit([2; 32]), Ok(()));
    assert_eq!(first.admit([2; 32]), Err(ErrorCode::StaleGeneration));
    // Retiring one generation leaves the other target's picker usable.
    assert_eq!(first.retire(), Ok(()));
    assert_eq!(second.admit([2; 32]), Ok(()));
}

#[test]
fn production_agent_session_uses_the_bound_master_image_before_any_dial() {
    let fixture = Fixture::new();
    let transport = fixture.transport("/test-no-ssh");
    let mut picker = MasterPicker::production(fixture.0.clone(), None);
    // The agent lane rides the same verified master; a non-system image is
    // refused while constructing the link, so no master and no second SSH
    // connection exists.
    assert_eq!(
        picker
            .open_production_agent_session(&transport, [1; 32], "/owner/agent --proxy")
            .err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    assert!(!picker.slot.has_live_master());
    // A stale generation is fenced before the master is consulted again.
    assert_eq!(
        picker
            .open_production_agent_session(&transport, [2; 32], "/owner/agent --proxy")
            .err(),
        Some(ErrorCode::StaleGeneration)
    );
}
