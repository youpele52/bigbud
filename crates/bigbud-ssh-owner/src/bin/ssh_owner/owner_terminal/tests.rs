use super::*;
use crate::transport::{Transport, TransportConfig};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::Ipv4Addr;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "macos")]
#[path = "tests/dev_interactive.rs"]
mod dev_interactive;
#[path = "tests/replay.rs"]
mod replay;

const PIN: &str = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
const PAUSED_SSH: &str = r#"#!/bin/sh
set -eu
[ -t 0 ] && [ -t 1 ]
[ "$1" = '-4' ] && [ "$2" = '-tt' ]
for arg; do
    case "$arg" in
        UserKnownHostsFile=*) pin=${arg#UserKnownHostsFile=};;
        -n) exit 1;;
        EscapeChar=none) no_escapes=yes;;
        StrictHostKeyChecking=yes) strict=yes;;
    esac
done
[ "$no_escapes" = yes ] && [ "$strict" = yes ]
/bin/sleep 0.05
[ -s "$pin" ]
# Execute only the exact fixed fixture command passed as the last SSH argument.
exec /bin/sh -c "$arg"
"#;
const RESIZE_SSH: &str = r#"#!/bin/sh
set -eu
stty -echo -echonl
printf '%s\n' BIGBUD_SSH_OWNER_PROOF_PTY_READY
while IFS= read -r line; do
    size=$(stty size)
    printf 'SIZE:%s\n' "$size"
done
"#;

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bigbud-s2-pty-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .expect("private fixture directory");
        Self(path)
    }

    fn transport(&self, script: &str, pin: bool) -> Transport {
        self.transport_with_workspace(script, pin, None, false)
    }

    fn transport_with_workspace(
        &self,
        script: &str,
        pin: bool,
        workspace_root: Option<PathBuf>,
        dev_interactive_terminal: bool,
    ) -> Transport {
        let ssh = self.0.join("ssh");
        fs::write(&ssh, script).expect("fixture SSH executable");
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).expect("execute fixture SSH");
        let known_hosts = self.0.join("known_hosts");
        if pin {
            fs::write(&known_hosts, PIN).expect("fixture pin");
            fs::set_permissions(&known_hosts, fs::Permissions::from_mode(0o600))
                .expect("restrict trust file permissions");
        }
        Transport::new(TransportConfig {
            ssh,
            keyscan: "/usr/bin/false".into(),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 2200,
            user: "fixture".into(),
            identity: crate::transport::write_identity_fixture(&self.0),
            known_hosts,
            alias_config: None,
            system_config: None,
            workspace_root,
            dev_interactive_terminal,
        })
        .expect("loopback-only transport")
    }

    fn pins(&self) -> Vec<PathBuf> {
        self.0
            .read_dir()
            .expect("fixture directory listing")
            .map(|entry| entry.expect("fixture entry"))
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".bigbud-picker-pin-")
            })
            .map(|entry| entry.path())
            .collect()
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn terminal_replays_the_same_child_and_revokes_only_after_reap() {
    let directory = Directory::new();
    let transport = directory.transport(PAUSED_SSH, true);
    let lease = transport.open_proof_terminal().expect("native PTY launch");
    // Launch waits for READY, but the fixture prints its size separately.
    wait_for_line(&lease, "BIGBUD_SSH_OWNER_PROOF_PTY_SIZE:24 80");
    let first = lease.snapshot().expect("first snapshot");
    assert!(first.live && first.pid > 0);
    assert!(
        first
            .sample
            .windows(READY.len())
            .any(|bytes| bytes == READY)
    );
    let pins = directory.pins();
    assert_eq!(pins.len(), 1);
    // Lifecycle is independent of the transport caller after open. Its pin is
    // still the per-operation copy even if the source trust record disappears.
    drop(transport);
    fs::remove_file(directory.0.join("known_hosts")).expect("remove source pin");
    assert_eq!(fs::read_to_string(&pins[0]).expect("leased pin"), PIN);
    let next = lease.snapshot().expect("replayed snapshot");
    assert_eq!(next.pid, first.pid);
    assert_eq!(next.sample, first.sample);
    assert!(next.live);
    assert_eq!(lease.revoke(), Ok(()));
    assert!(lease.handle.child_reaped());
    assert_eq!(lease.revoke(), Ok(()));
    let revoked = lease.snapshot().expect("reaped snapshot");
    assert_eq!(revoked.pid, first.pid);
    assert!(!revoked.live);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !lease.reader_finished() && Instant::now() < deadline {
        thread::sleep(POLL);
    }
    assert!(lease.reader_finished());
    assert!(directory.pins().is_empty());
}

fn wait_for_line(lease: &TerminalLease, expected: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let status = lease.snapshot().expect("PTY output snapshot");
        assert!(status.live);
        let sample = String::from_utf8(status.sample).expect("text fixture output");
        if sample.lines().any(|line| line == expected) {
            return sample;
        }
        assert!(
            Instant::now() < deadline,
            "missing {expected:?}: {sample:?}"
        );
        thread::sleep(POLL);
    }
}

#[test]
fn fixture_refuses_to_print_ready_without_a_tty() {
    let output = std::process::Command::new("/bin/sh")
        .args(["-c", FIXTURE_COMMAND])
        .output()
        .expect("start fixed command without a TTY");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn terminal_input_echoes_literal_lines_once_and_never_retries_a_fenced_sequence() {
    const ECHO: &str = "BIGBUD_SSH_OWNER_PROOF_PTY_ECHO:";
    // Would exit the fixture and emit different output if evaluated as shell code.
    let literal = r"  $(printf EXPANDED); exit 99; %s \n  ";
    let input = format!("{literal}\n");
    let directory = Directory::new();
    let lease = directory
        .transport(PAUSED_SSH, true)
        .open_proof_terminal()
        .expect("native PTY launch");

    for (sequence, data) in [
        (0, b"invalid\n".as_slice()),
        (1, b"".as_slice()),
        (1, &[b'x'; MAX_INPUT_BYTES + 1]),
        (2, b"gapped\n".as_slice()),
    ] {
        assert_eq!(
            lease.write_proof_input(sequence, data),
            Err(ErrorCode::InvalidOperands)
        );
    }
    assert_eq!(lease.write_proof_input(1, input.as_bytes()), Ok(()));
    assert_eq!(lease.write_proof_input(1, input.as_bytes()), Ok(()));
    assert_eq!(
        lease.write_proof_input(1, b"conflict\n"),
        Err(ErrorCode::InvalidOperands)
    );

    // Retire a sequence directly in the shared ledger. The proof adapter must
    // not retry it, substitute another sequence, or turn the fence into an ACK.
    let retired = b"retired\n";
    lease
        .handle
        .reconcile_input(2, Sha256::digest(retired).into(), retired.len(), true)
        .expect("retire unwritten sequence");
    assert_eq!(
        lease.write_proof_input(2, retired),
        Err(ErrorCode::OutcomeUnknown)
    );
    assert_eq!(lease.write_proof_input(3, b"control\x1b[2J\n"), Ok(()));
    assert_eq!(lease.write_proof_input(4, b"barrier\n"), Ok(()));
    let barrier = format!("{ECHO}barrier");
    let sample = wait_for_line(&lease, &barrier);
    let echo = format!("{ECHO}{literal}");
    assert_eq!(
        sample.lines().collect::<Vec<_>>(),
        [
            std::str::from_utf8(READY).expect("text marker"),
            "BIGBUD_SSH_OWNER_PROOF_PTY_SIZE:24 80",
            &echo,
            &barrier
        ]
    );

    lease.revoke().expect("reap proof terminal");
    assert_eq!(
        lease.write_proof_input(5, b"after revoke\n"),
        Err(ErrorCode::OperationDenied)
    );
    assert_eq!(
        lease.resize_proof_terminal(80, 24),
        Err(ErrorCode::OperationDenied)
    );
}

#[test]
fn terminal_resize_enforces_bounds_and_changes_the_native_tty() {
    let directory = Directory::new();
    let lease = directory
        .transport(RESIZE_SSH, true)
        .open_proof_terminal()
        .expect("native PTY launch");
    for (cols, rows) in [(0, 24), (80, 0), (MAX_COLS + 1, 24), (80, MAX_ROWS + 1)] {
        assert_eq!(
            lease.resize_proof_terminal(cols, rows),
            Err(ErrorCode::InvalidOperands)
        );
    }
    assert_eq!(lease.resize_proof_terminal(MAX_COLS, MAX_ROWS), Ok(()));
    assert_eq!(lease.write_proof_input(1, b"\n"), Ok(()));
    wait_for_line(&lease, "SIZE:200 400");
    assert_eq!(lease.resize_proof_terminal(1, 1), Ok(()));
    assert_eq!(lease.write_proof_input(2, b"\n"), Ok(()));
    wait_for_line(&lease, "SIZE:1 1");
}

#[test]
fn drop_reaps_the_lease_child_without_revoking_another() {
    let first_dir = Directory::new();
    let first = first_dir
        .transport(PAUSED_SSH, true)
        .open_proof_terminal()
        .expect("first fixed PTY");
    let second_dir = Directory::new();
    let second = second_dir
        .transport(PAUSED_SSH, true)
        .open_proof_terminal()
        .expect("second fixed PTY");
    let first_handle = Arc::clone(&first.handle);
    assert_ne!(first_handle.pid, second.handle.pid);
    drop(first);
    assert!(first_handle.child_reaped());
    assert!(second.snapshot().expect("second snapshot").live);
}

#[test]
fn late_hard_expiry_worker_closes_only_its_retained_handle() {
    let first_dir = Directory::new();
    let second_dir = Directory::new();
    let first_transport = first_dir.transport(PAUSED_SSH, true);
    let first = first_transport.open_proof_terminal().expect("first PTY");
    let second = second_dir
        .transport(PAUSED_SSH, true)
        .open_proof_terminal()
        .expect("second PTY");
    let pid = first.pid();
    assert_ne!(pid, second.pid());
    drop(first_transport);

    let (reader_completion, reader_done) = mpsc::channel();
    // Simulate a watchdog first scheduled after its pre-launch deadline. Keep
    // the completion channel open: the deadline, not reader exit, must close it.
    let expires_at = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .expect("past fixture deadline");
    let worker = expiry::start(Arc::clone(&first.handle), reader_done, expires_at)
        .expect("start expiry worker");
    let by = PtyHandle::close_deadline() + Duration::from_secs(1);
    while !worker.is_finished() && Instant::now() < by {
        thread::sleep(POLL);
    }
    assert!(worker.is_finished(), "expired watchdog restarted its wait");
    worker.join().expect("join watchdog");
    drop(reader_completion);
    assert!(first.handle.child_reaped());
    let ended = first.snapshot().expect("retained terminal status");
    assert_eq!(ended.pid, pid);
    assert!(!ended.live);
    assert_eq!(first.revoke(), Ok(()));
    second
        .write_proof_input(1, b"independent\n")
        .expect("unrelated terminal still accepts input");
    wait_for_line(&second, "BIGBUD_SSH_OWNER_PROOF_PTY_ECHO:independent");
}

#[test]
fn open_requires_the_private_pin_and_successful_auth_evidence() {
    let no_pin = Directory::new();
    assert!(matches!(
        no_pin.transport(PAUSED_SSH, false).open_proof_terminal(),
        Err(ErrorCode::TrustRequired)
    ));
    let auth = Directory::new();
    let denied = "#!/bin/sh\nprintf '%s\\n' 'Permission denied (publickey).'\nexit 255\n";
    assert!(matches!(
        auth.transport(denied, true).open_proof_terminal(),
        Err(ErrorCode::AuthRequired)
    ));
    assert!(auth.pins().is_empty());
}

#[test]
fn failed_native_exec_settles_before_releasing_its_private_pin() {
    let directory = Directory::new();
    let transport = directory.transport(PAUSED_SSH, true);
    fs::remove_file(directory.0.join("ssh")).expect("remove only the fixture executable");
    assert!(matches!(
        transport.open_proof_terminal(),
        Err(ErrorCode::OwnerUnavailable)
    ));
    assert!(directory.pins().is_empty());
}
