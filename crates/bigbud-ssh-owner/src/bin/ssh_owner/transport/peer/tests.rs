use super::*;
use crate::transport::TransportConfig;
use std::ffi::OsStr;
use std::io::Write;
use std::net::Ipv4Addr;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicU64, Ordering};

const PIN: &str = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
const OTHER_PIN: &str = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB\n";
const HOST_FP: &str = "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk";
const GRANT_FP: &str = "sha256:92661cbdd8b61a43de5b107a5cb8eb641f091eccb61e6f25b87305a7d18cbea9";
static SERIAL: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        // A short root also leaves room for the Unix-domain test socket path.
        let base = Path::new("/tmp").canonicalize().unwrap();
        let root = base.join(format!(
            "bb-peer-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        path
    }

    fn scanner(&self, record: &str) {
        // A recording substitute; neither this nor the configured SSH path
        // can open a network connection. Reject any inherited agent socket.
        let script = format!(
            "#!/bin/sh\n[ -z \"${{SSH_AUTH_SOCK-}}\" ] || exit 1\nprintf '%s\\n' '{}'\n",
            record.trim_end()
        );
        let path = self.file("scan", script.as_bytes());
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    fn key(&self, name: &str) -> String {
        let mut helper = keygen().unwrap();
        helper
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "fixture-comment",
                "-f",
            ])
            .arg(self.0.join(name));
        assert!(matches!(
            process::run(helper, Instant::now() + DEADLINE, PUBLIC_LIMIT),
            Ok(output) if output.status.success()
        ));
        public_key(&fs::read(self.0.join(format!("{name}.pub"))).unwrap())
            .unwrap()
            .fingerprint()
    }

    fn config(&self) -> TransportConfig {
        TransportConfig {
            ssh: self.0.join("must-not-spawn"),
            keyscan: self.0.join("scan"),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 2200,
            user: "fixture".into(),
            identity: self.0.join("key"),
            known_hosts: self.0.join("known_hosts"),
            alias_config: None,
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn peer_requires_provisioned_exact_worker_pin_before_key_handling() {
    let fixture = Fixture::new();
    // This opaque identity would fail AuthRequired if reached by the helper.
    fixture.file("key", b"invalid key containing private marker");
    let transport = Transport::new(fixture.config()).unwrap();
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, GRANT_FP),
        Err(ErrorCode::TrustRequired)
    ));
    assert!(!fixture.0.join("known_hosts").exists());
    let store = fixture.file("known_hosts", OTHER_PIN.as_bytes());
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, GRANT_FP),
        Err(ErrorCode::HostKeyChanged)
    ));
    fs::write(&store, PIN).unwrap();
    fixture.scanner(OTHER_PIN);
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, GRANT_FP),
        Err(ErrorCode::HostKeyChanged)
    ));
    assert_eq!(fs::read_to_string(store).unwrap(), PIN);
}

#[test]
fn peer_command_uses_exact_snapshot_and_fixed_isolated_exec() {
    let fixture = Fixture::new();
    let coordinator = fixture.key("key");
    let store = fixture.file("known_hosts", PIN.as_bytes());
    fixture.scanner(PIN);
    let transport = Transport::new(fixture.config()).unwrap();
    let pinned = transport.pinned_peer_ssh(HOST_FP, &coordinator).unwrap();
    let args: Vec<_> = pinned.command.get_args().collect();
    assert!(args.ends_with(&["--", "127.0.0.1", "bigbud-peer"].map(OsStr::new)));
    assert!(args.windows(2).any(|args| args == ["-F", "/dev/null"]));
    let identity = sole_identity(&args).unwrap();
    assert_eq!(identity, fixture.0.join("key").as_os_str());
    assert!(!args.contains(&OsStr::new("-A")));
    assert!(!args.contains(&OsStr::new("-tt")));
    for option in [
        "-T",
        "StrictHostKeyChecking=yes",
        "GlobalKnownHostsFile=none",
        "KnownHostsCommand=none",
        "HostKeyAlgorithms=ssh-ed25519",
        "IdentityAgent=none",
        "IdentitiesOnly=yes",
        "BatchMode=yes",
        "ControlMaster=no",
        "ControlPath=none",
        "ControlPersist=no",
        "ProxyCommand=none",
        "ProxyJump=none",
        "ClearAllForwardings=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
        "EscapeChar=none",
    ] {
        assert!(args.contains(&OsStr::new(option)), "missing {option}");
    }
    assert!(args.contains(&OsStr::new(&format!(
        "UserKnownHostsFile={}",
        pinned._snapshot.path().display()
    ))));
    assert!(
        pinned
            .command
            .get_envs()
            .eq([(OsStr::new("LC_ALL"), Some(OsStr::new("C")))])
    );

    // Existing commands retain their exact pin; future calls don't follow a
    // replaced store, even when the replacement uses the same endpoint label.
    fs::write(&store, OTHER_PIN).unwrap();
    assert_eq!(fs::read_to_string(pinned._snapshot.path()).unwrap(), PIN);
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, &coordinator),
        Err(ErrorCode::HostKeyChanged)
    ));
    let snapshot = pinned._snapshot.path().to_owned();
    drop(pinned);
    assert!(!snapshot.exists());
}

#[test]
fn peer_refuses_wrong_private_key_and_unrelated_sidecar() {
    let fixture = Fixture::new();
    let coordinator = fixture.key("key");
    let other = fixture.key("other");
    fixture.file("known_hosts", PIN.as_bytes());
    fixture.scanner(PIN);
    let transport = Transport::new(fixture.config()).unwrap();
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, &other),
        Err(ErrorCode::AuthRequired)
    ));

    // A newly bound transport should reject a sidecar substitution even if
    // it was already present at startup and its permissions pass admission.
    fs::rename(fixture.0.join("other.pub"), fixture.0.join("key.pub")).unwrap();
    let transport = Transport::new(fixture.config()).unwrap();
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, &coordinator),
        Err(ErrorCode::AuthRequired)
    ));
    fs::remove_file(fixture.0.join("key.pub")).unwrap();
    let transport = Transport::new(fixture.config()).unwrap();
    assert!(transport.pinned_peer_ssh(HOST_FP, &coordinator).is_ok());
}

#[test]
fn peer_rejects_agent_config_and_development_terminal_modes() {
    let fixture = Fixture::new();
    let key = fixture.file("key", b"not used");
    let mut config = fixture.config();
    config.dev_interactive_terminal = true;
    let transport = Transport::new(config).unwrap();
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, GRANT_FP),
        Err(UNSUPPORTED)
    ));

    let socket = fixture.0.join("agent");
    let _listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    let mut transport = Transport::new(fixture.config()).unwrap();
    transport.bind_proof_agent(&socket).unwrap();
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, GRANT_FP),
        Err(UNSUPPORTED)
    ));

    fixture.file("known_hosts", PIN.as_bytes());
    let mut config = fixture.config();
    let alias = format!(
        "Host worker\nHostName 127.0.0.1\nPort 2200\nUser fixture\nIdentityFile {}\nUserKnownHostsFile {}\n",
        key.display(),
        config.known_hosts.display()
    );
    config.alias_config = Some((fixture.file("config", alias.as_bytes()), "worker".into()));
    let transport = Transport::new(config).unwrap();
    assert!(matches!(
        transport.pinned_peer_ssh(HOST_FP, GRANT_FP),
        Err(UNSUPPORTED)
    ));
}

#[test]
fn keygen_failure_is_redacted_after_trust_matches() {
    let fixture = Fixture::new();
    fixture.file("key", b"private-marker-that-must-not-escape");
    fixture.file("known_hosts", PIN.as_bytes());
    fixture.scanner(PIN);
    let transport = Transport::new(fixture.config()).unwrap();
    let result = transport.pinned_peer_ssh(HOST_FP, GRANT_FP);
    assert!(matches!(result, Err(ErrorCode::AuthRequired)));
}

#[test]
fn public_key_comments_are_not_fingerprint_input() {
    let row = PIN.split_once(' ').unwrap().1.trim_end();
    let bytes = format!("{row} private-looking-comment\n");
    assert_eq!(public_key(bytes.as_bytes()).unwrap().fingerprint(), HOST_FP);
    assert!(public_key(format!("{row}\n{row}\n").as_bytes()).is_none());
    assert!(matches_grant_fingerprint(GRANT_FP, HOST_FP));
    assert!(!matches_grant_fingerprint(
        &GRANT_FP.to_uppercase(),
        HOST_FP
    ));
    assert!(!matches_grant_fingerprint(
        &GRANT_FP.replace('9', "0"),
        HOST_FP
    ));
}
