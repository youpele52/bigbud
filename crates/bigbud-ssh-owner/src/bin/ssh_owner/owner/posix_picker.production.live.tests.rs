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
        host_identity: Default::default(),
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
        .open_login_terminal(&cwd, 80, 24, None)
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

/// Host-gated: the production agent proxy must open one mux session over the
/// already-verified master, carry framed bytes both ways, confirm an explicit
/// exit and reuse the same master process for a second target session.
#[test]
#[ignore = "requires a separately approved, running throwaway loopback sshd with generated keys"]
fn production_agent_proxy_reuses_the_verified_master_and_confirms_exit() {
    use crate::owner_agent_proxy::ProductionProxy;

    assert_eq!(
        std::env::var("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE").as_deref(),
        Ok("approved-disposable")
    );
    let root = PathBuf::from(required("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE_ROOT"));
    assert_eq!(root.parent(), Some(Path::new("/private/tmp")));
    let port = required("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE_PORT")
        .parse::<u16>()
        .expect("numeric fixture port");
    let user = required("BIGBUD_SSH_OWNER_PRODUCTION_FIXTURE_USER");
    let public = fs::read_to_string(root.join("host-key.pub")).expect("generated host key");
    let mut fields = public.split_ascii_whitespace();
    let key_type = fields.next().expect("fixture key type");
    let key = fields.next().expect("fixture key blob");
    let mut known_hosts = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(root.join("known_hosts"))
        .expect("explicit fixture pin");
    known_hosts
        .write_all(format!("[127.0.0.1]:{port} {key_type} {key}\n").as_bytes())
        .expect("write pin");
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
        host_identity: Default::default(),
    })
    .expect("production-shaped transport");

    let generation = [8; 32];
    let mut picker = MasterPicker::production(root.clone(), None);
    let command = "printf 'agent-hello\\n'";
    let (pid, io) = picker
        .open_production_agent_session(&transport, generation, command)
        .expect("agent session over the master");
    let mut first = ProductionProxy::new([1; 32], pid, io).expect("bounded proxy");
    first.grant_output_credit(256).expect("reader credit");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    while Instant::now() < deadline && !output.windows(11).any(|w| w == b"agent-hello") {
        if let Some(chunk) = first.receive().expect("framed output") {
            output.extend(chunk);
        } else {
            thread::sleep(Duration::from_millis(5));
        }
    }
    assert!(
        output.windows(11).any(|window| window == b"agent-hello"),
        "no framed hello over the production master"
    );
    let status = first.close(true, 5_000).expect("confirmed proxy exit");
    assert!(status.closed);
    assert_eq!(status.code, Some(0));

    // A second session reuses the same verified master process.
    let (second_pid, second_io) = picker
        .open_production_agent_session(&transport, generation, command)
        .expect("second agent session");
    assert_eq!(second_pid, pid, "the master was re-dialled");
    let mut second = ProductionProxy::new([2; 32], second_pid, second_io).expect("bounded proxy");
    second.grant_output_credit(256).expect("reader credit");
    let _ = second.close(false, 5_000);
    assert_eq!(picker.test_live_pid(), Some(pid));
    picker.retire().expect("checked master reap");
}
