//! Host-gated live production master + PTY test.

use super::*;

use crate::owner_trust::TrustApproval;
use crate::v1::TrustState;
use std::{
    fs,
    io::Write,
    net::Ipv4Addr,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing {name}"))
}

/// Host-gated: requires a separately approved disposable loopback sshd with
/// generated keys, exactly like the existing `posix_master` live fixtures.
#[test]
#[ignore = "requires a separately approved, running throwaway loopback sshd with generated keys"]
fn production_master_is_reused_and_the_login_pty_round_trips() {
    assert_eq!(
        std::env::var("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE").as_deref(),
        Ok("approved-disposable")
    );
    let root = PathBuf::from(required("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE_ROOT"));
    assert_eq!(root.parent(), Some(Path::new("/private/tmp")));
    assert!(
        root.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("bigbud-picker-sshd-"))
    );
    let port = required("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE_PORT")
        .parse::<u16>()
        .expect("numeric fixture port");
    assert!(port >= 1024);
    let user = required("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE_USER");
    let cwd =
        std::env::var("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE_CWD").unwrap_or_else(|_| "/tmp".into());

    let public = fs::read_to_string(root.join("host-key.pub")).expect("generated host key");
    let mut fields = public.split_ascii_whitespace();
    let key_type = fields.next().expect("fixture key type");
    let key = fields.next().expect("fixture key blob");
    let pin = format!("[127.0.0.1]:{port} {key_type} {key}\n");
    let mut known_hosts = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(root.join("known_hosts"))
        .expect("explicit fixture pin");
    known_hosts.write_all(pin.as_bytes()).expect("write pin");

    let transport = Transport::new(TransportConfig {
        ssh: "/usr/bin/ssh".into(),
        keyscan: "/usr/bin/ssh-keyscan".into(),
        host: Ipv4Addr::LOCALHOST.into(),
        port,
        user,
        identity: root.join("identity"),
        known_hosts: root.join("known_hosts"),
        alias_config: None,
        system_config: None,
        workspace_root: None,
        dev_interactive_terminal: false,
    })
    .expect("production-shaped transport");

    let trust = TrustApproval::default()
        .inspect(&transport)
        .expect("trust inspection");
    assert_eq!(trust.state, TrustState::Verified as i32);

    let generation = [7; 32];
    let mut picker = MasterPicker::production(root.clone(), None);
    picker
        .list(&transport, generation, Some(&cwd))
        .expect("bounded folder list through the production master");
    let master_pid = picker.test_live_pid().expect("live master");
    picker
        .list(&transport, generation, Some(&cwd))
        .expect("second bounded folder list");
    assert_eq!(
        picker.test_live_pid(),
        Some(master_pid),
        "the production master was re-dialled instead of reused"
    );

    let terminal = transport
        .open_login_terminal(&cwd, 80, 24)
        .expect("target login shell");
    terminal
        .resize_proof_terminal(100, 40)
        .expect("resize the login shell PTY");
    terminal
        .write_proof_input(1, b"printf 'BIGBUD_PRODUCTION_PTY_MARK\\n'\n")
        .expect("send input to the login shell");
    let marker = b"BIGBUD_PRODUCTION_PTY_MARK";
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = terminal.snapshot().expect("PTY snapshot");
        if status
            .sample
            .windows(marker.len())
            .any(|window| window == marker)
        {
            break;
        }
        assert!(Instant::now() < deadline, "login shell produced no output");
        thread::sleep(Duration::from_millis(10));
    }
    let replay = terminal
        .replay_proof_terminal(0)
        .expect("bounded PTY replay");
    assert!(
        replay
            .chunks
            .iter()
            .any(|(_, data)| data.windows(marker.len()).any(|window| window == marker))
    );
    terminal.revoke().expect("close the login shell");

    // A changed trust record is refused against the retained master before
    // any new SSH child or mux session: the exact pin no longer matches.
    let other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
    let mut changed = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(root.join("known_hosts"))
        .expect("rewrite pin");
    changed
        .write_all(format!("[127.0.0.1]:{port} {other}\n").as_bytes())
        .expect("changed pin");
    assert_eq!(
        picker.list(&transport, generation, Some(&cwd)),
        Err(ErrorCode::HostKeyChanged)
    );
    // The changed pin tears down this target's master; no other target is
    // involved and the owner can reopen only after trust is re-approved.
    assert!(!picker.slot.has_live_master());

    picker.retire().expect("checked master reap");
    assert!(!picker.slot.has_live_master());
}
