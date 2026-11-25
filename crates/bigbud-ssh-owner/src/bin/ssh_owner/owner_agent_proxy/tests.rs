use super::*;
use crate::transport::TransportConfig;
use std::io::Write;
use std::net::Ipv4Addr;
use std::os::fd::IntoRawFd;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::os::unix::net::UnixStream;

const PIN: &str = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
const FAKE_SSH: &str = r#"#!/bin/sh
set -eu
[ "$1" = '-4' ] && [ "$2" = '-T' ] || exit 99
for arg; do
    case "$arg" in
        UserKnownHostsFile=*) pin=${arg#UserKnownHostsFile=};;
        StrictHostKeyChecking=yes) strict=yes;;
    esac
    previous=${last:-}
    last=$arg
done
[ "$strict" = yes ] && [ -s "$pin" ] && [ "$previous" = 127.0.0.1 ] || exit 98
exec /bin/sh -c "$last"
"#;
const ECHO_AGENT: &str = r#"#!/bin/sh
[ "$#" = 1 ] && [ "$1" = '--ephemeral' ] || exit 97
printf 'ready\n' >&2
IFS= read -r line || exit 96
printf '<%s>\n' "$line"
exit 17
"#;
const STUCK_AGENT: &str = r#"#!/bin/sh
trap '' TERM
printf 'ready\n' >&2
read -r ignored
"#;

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let token = random_token().expect("fixture nonce");
        let name = format!("bigbud-proof-proxy-{:x}", Sha256::digest(token));
        let path = std::env::temp_dir()
            .canonicalize()
            .expect("canonical temp directory")
            .join(name);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .expect("private fixture directory");
        Self(path)
    }

    fn executable(&self, name: &str, script: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, script).expect("fixture file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("private executable");
        path
    }

    fn transport(&self) -> Transport {
        let known_hosts = self.0.join("known_hosts");
        fs::write(&known_hosts, PIN).expect("fixture pin");
        fs::set_permissions(&known_hosts, fs::Permissions::from_mode(0o600)).expect("private pin");
        Transport::new(TransportConfig {
            ssh: self.executable("ssh", FAKE_SSH),
            keyscan: "/usr/bin/false".into(),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 2200,
            user: "fixture".into(),
            identity: crate::transport::write_identity_fixture(&self.0),
            known_hosts,
            alias_config: None,
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
        })
        .expect("loopback proof transport")
    }

    fn fixture(
        &self,
        script: &str,
    ) -> (AgentProxyFixture, v1::ProofAgentProxyOpen, [UnixStream; 3]) {
        let binary = self.executable("agent's $(unexpanded) path", script);
        let sha256 = format!("{:x}", Sha256::digest(script));
        let input = v1::ProofAgentProxyOpen {
            binary_path: binary.to_str().expect("text path").to_owned(),
            sha256: sha256.clone(),
        };
        let (stdin, stdin_peer) = stream_pair();
        let (stdout, stdout_peer) = stream_pair();
        let (stderr, stderr_peer) = stream_pair();
        let fds = [stdin, stdout, stderr].map(IntoRawFd::into_raw_fd);
        // SAFETY: these three live, distinct socket ends were transferred above.
        let pipes = unsafe { adopt_pipes(fds) }.expect("owned streams");
        for fd in fds {
            // SAFETY: these descriptors are live and owned by pipes.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert_ne!(flags, -1);
            assert_ne!(flags & libc::FD_CLOEXEC, 0);
        }
        let fixture = AgentProxyFixture {
            binary,
            sha256,
            pipes: Some(pipes),
            installed: None,
            scoped: None,
            relay: None,
            provider: None,
        };
        (fixture, input, [stdin_peer, stdout_peer, stderr_peer])
    }

    fn pins(&self) -> Vec<PathBuf> {
        self.0
            .read_dir()
            .expect("fixture directory")
            .map(|entry| entry.expect("fixture entry").path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.as_encoded_bytes().starts_with(b".bigbud-picker-pin-"))
            })
            .collect()
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

fn stream_pair() -> (UnixStream, UnixStream) {
    let (child, peer) = UnixStream::pair().expect("fixture socket pair");
    let timeout = Some(Duration::from_secs(2));
    peer.set_read_timeout(timeout)
        .expect("bounded fixture read");
    peer.set_write_timeout(timeout)
        .expect("bounded fixture write");
    (child, peer)
}

fn ready(stderr: &mut UnixStream) {
    let mut marker = [0; 6];
    stderr.read_exact(&mut marker).expect("fixture ready");
    assert_eq!(&marker, b"ready\n");
}

#[test]
fn one_child_owns_three_streams_and_the_pin_until_reaped() {
    let directory = Directory::new();
    let transport = directory.transport();
    let (mut fixture, input, [mut stdin, mut stdout, mut stderr]) = directory.fixture(ECHO_AGENT);
    let mut lease = fixture
        .open(&transport, &input)
        .expect("open approved proxy");
    ready(&mut stderr);
    let before = lease.status().expect("live status");
    assert!(!before.closed);
    assert_eq!((before.code, before.signal), (None, None));
    assert_eq!(before.lease.len(), 32);
    assert_ne!(before.pid, 0);
    assert_eq!(directory.pins().len(), 1);
    assert_eq!(
        fs::read_to_string(&directory.pins()[0]).expect("leased host pin"),
        PIN
    );
    assert_eq!(lease.close(false, 0), Err(ErrorCode::OutcomeUnknown));
    assert!(
        !lease
            .status()
            .expect("still live without termination")
            .closed
    );

    stdin.write_all(b"direct stream\n").expect("write to child");
    let mut bytes = Vec::new();
    stdout
        .read_to_end(&mut bytes)
        .expect("stdout has no owner-held copy");
    assert_eq!(bytes, b"<direct stream>\n");
    let after = lease.close(false, 2_000).expect("natural exit reaped");
    assert_eq!(after.lease, before.lease);
    assert_eq!(after.pid, before.pid);
    assert!(after.closed);
    assert_eq!((after.code, after.signal), (Some(17), None));
    assert_eq!(lease.close(true, 0), Ok(after));
    assert!(directory.pins().is_empty());
    assert!(matches!(
        fixture.open(&transport, &input),
        Err(ErrorCode::OperationDenied)
    ));
}

#[test]
fn bounded_close_escalates_and_reports_the_actual_signal() {
    let directory = Directory::new();
    let transport = directory.transport();
    let (mut fixture, input, [_stdin, _stdout, mut stderr]) = directory.fixture(STUCK_AGENT);
    let mut lease = fixture
        .open(&transport, &input)
        .expect("open approved proxy");
    ready(&mut stderr);
    let exit = lease.close(true, 2_000).expect("reaped after escalation");
    assert!(exit.closed);
    assert_eq!((exit.code, exit.signal), (None, Some(libc::SIGKILL)));
    assert!(directory.pins().is_empty());
}

#[test]
fn denied_operands_and_changed_bytes_never_consume_the_streams() {
    let directory = Directory::new();
    let transport = directory.transport();
    let (mut fixture, input, [_stdin, _stdout, mut stderr]) = directory.fixture(ECHO_AGENT);
    let wrong_path = v1::ProofAgentProxyOpen {
        binary_path: format!(
            "{}/./{}",
            directory.0.display(),
            "agent's $(unexpanded) path"
        ),
        ..input.clone()
    };
    let wrong_digest = v1::ProofAgentProxyOpen {
        sha256: "0".repeat(64),
        ..input.clone()
    };
    for wrong in [wrong_path, wrong_digest] {
        assert!(matches!(
            fixture.open(&transport, &wrong),
            Err(ErrorCode::OperationDenied)
        ));
    }
    fs::write(&fixture.binary, STUCK_AGENT).expect("replace fixture content");
    assert!(matches!(
        fixture.open(&transport, &input),
        Err(ErrorCode::OperationDenied)
    ));
    assert!(directory.pins().is_empty());
    fs::write(&fixture.binary, ECHO_AGENT).expect("restore exact fixture");
    let mut lease = fixture
        .open(&transport, &input)
        .expect("approved streams still available");
    ready(&mut stderr);
    assert!(lease.close(true, 2_000).expect("cleanup").closed);
}

#[test]
fn installed_binding_refuses_other_request_operands_before_ssh() {
    let directory = Directory::new();
    let transport = directory.transport();
    let (mut fixture, input, _streams) = directory.fixture(ECHO_AGENT);
    fixture.installed = Some(
        installed::Recipe::new(&fixture.binary, &fixture.sha256, Path::new("/guest/state"))
            .expect("startup binding"),
    );
    for wrong in [
        v1::ProofAgentProxyOpen {
            binary_path: format!("{}/./agent's $(unexpanded) path", directory.0.display()),
            ..input.clone()
        },
        v1::ProofAgentProxyOpen {
            sha256: "0".repeat(64),
            ..input.clone()
        },
    ] {
        assert!(matches!(
            fixture.open(&transport, &wrong),
            Err(ErrorCode::OperationDenied)
        ));
    }
    assert!(fixture.pipes.is_some());
    assert!(directory.pins().is_empty());
}

#[test]
fn failed_spawn_still_consumes_the_inherited_streams() {
    let directory = Directory::new();
    let transport = directory.transport();
    let (mut fixture, input, [_stdin, mut stdout, _stderr]) = directory.fixture(ECHO_AGENT);
    fs::remove_file(directory.0.join("ssh")).expect("remove fixture executable");
    assert!(matches!(
        fixture.open(&transport, &input),
        Err(ErrorCode::OwnerUnavailable)
    ));
    assert!(directory.pins().is_empty());
    assert_eq!(stdout.read(&mut [0]).expect("stream closed"), 0);
    directory.executable("ssh", FAKE_SSH);
    assert!(matches!(
        fixture.open(&transport, &input),
        Err(ErrorCode::OperationDenied)
    ));
}

#[test]
fn verification_rejects_nonprivate_linked_and_oversized_binaries() {
    let directory = Directory::new();
    let binary = directory.executable("agent", ECHO_AGENT);
    let sha256 = format!("{:x}", Sha256::digest(ECHO_AGENT));
    assert!(verify_digest(&binary, &sha256).is_ok());
    let alias = directory.0.join("alias");
    symlink(&binary, &alias).expect("symlink");
    assert!(verify_digest(&alias, &sha256).is_err());
    fs::remove_file(&alias).expect("remove symlink");
    fs::hard_link(&binary, &alias).expect("hard link");
    assert!(verify_digest(&binary, &sha256).is_err());
    fs::remove_file(&alias).expect("remove hard link");
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).expect("public mode");
    assert!(verify_digest(&binary, &sha256).is_err());
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).expect("restore private mode");
    File::options()
        .write(true)
        .open(&binary)
        .expect("open fixture executable")
        .set_len(MAX_BINARY_BYTES + 1)
        .expect("oversized sparse fixture");
    assert!(verify_digest(&binary, &sha256).is_err());
}
