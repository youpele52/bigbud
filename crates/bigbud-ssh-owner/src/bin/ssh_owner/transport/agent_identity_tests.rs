use super::*;
use crate::transport::{TransportConfig, write_identity_fixture};
use std::net::Ipv4Addr;
use std::os::unix::{
    fs::{DirBuilderExt, PermissionsExt, symlink},
    net::UnixListener,
};
use std::sync::atomic::{AtomicU64, Ordering};

const PIN: &str = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        // Keep below sockaddr_un's path limit even on macOS, and use the
        // physical spelling there so no system symlink needs a bypass.
        let temp = if cfg!(target_os = "macos") {
            "/private/tmp"
        } else {
            "/tmp"
        };
        let dir = Path::new(temp).join(format!(
            "bb-agent-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        Self(dir)
    }

    fn transport(&self) -> Transport {
        self.transport_with_policy(None).unwrap()
    }

    fn transport_with_policy(&self, agent: Option<&str>) -> Result<Transport, ErrorCode> {
        let ssh = self.0.join("record-ssh");
        fs::write(
            &ssh,
            "#!/bin/sh\n[ \"${SSH_AUTH_SOCK+x}\" != x ] || exit 1\nprintf '%s\\n' \"$@\"\n",
        )
        .unwrap();
        chmod(&ssh, 0o700);
        let identity = write_identity_fixture(&self.0);
        let known_hosts = self.0.join("known_hosts");
        let alias_config = agent.map(|agent| {
            let config = self.0.join("config");
            fs::write(
                &config,
                format!("Host fixture\nHostName 127.0.0.1\nPort 2200\nUser fixture\nIdentityFile {}\nUserKnownHostsFile {}\nIdentityAgent {agent}\n", identity.display(), known_hosts.display()),
            ).unwrap();
            chmod(&config, 0o600);
            (config, "fixture".to_owned())
        });
        Transport::new(TransportConfig {
            ssh,
            keyscan: self.0.join("unused-keyscan"),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 2200,
            user: "fixture".into(),
            identity,
            known_hosts,
            alias_config,
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
        })
    }

    fn pin(&self) {
        let known_hosts = self.0.join("known_hosts");
        fs::write(&known_hosts, PIN).unwrap();
        chmod(&known_hosts, 0o600);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

fn chmod(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn listen(path: &Path) -> UnixListener {
    let listener = UnixListener::bind(path).unwrap();
    chmod(path, 0o600);
    listener
}

fn assert_refused(transport: &Transport) {
    assert!(matches!(transport.pinned_ssh("-T"), Err(UNSUPPORTED)));
}

fn record(transport: &Transport, identity_agent: &str) -> Vec<String> {
    let mut pinned = transport.pinned_ssh("-T").unwrap();
    assert!(
        pinned
            .command
            .get_envs()
            .any(|(key, value)| key == "SSH_AUTH_SOCK" && value.is_none())
    );
    let output = pinned.command.output().unwrap();
    assert!(output.status.success());
    let args = String::from_utf8(output.stdout).unwrap();
    let agent_options: Vec<_> = args
        .lines()
        .filter(|line| line.starts_with("IdentityAgent="))
        .collect();
    assert_eq!(agent_options, [identity_agent]);
    for option in [
        "StrictHostKeyChecking=yes",
        "HostKeyAlgorithms=ssh-ed25519",
        "PubkeyAcceptedAlgorithms=ssh-ed25519",
        "BatchMode=yes",
        "PreferredAuthentications=publickey",
        "IdentitiesOnly=yes",
        "AddKeysToAgent=no",
        "ForwardAgent=no",
        "ClearAllForwardings=yes",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "ControlMaster=no",
    ] {
        assert!(args.lines().any(|line| line == option), "missing {option}");
    }
    let snapshot = args
        .lines()
        .find_map(|line| line.strip_prefix("UserKnownHostsFile="))
        .unwrap();
    assert_eq!(fs::read_to_string(snapshot).unwrap(), PIN);
    args.lines()
        .filter(|line| {
            !line.starts_with("IdentityAgent=") && !line.starts_with("UserKnownHostsFile=")
        })
        .map(str::to_owned)
        .collect()
}

#[test]
fn agent_identity_recorder_keeps_pin_and_auth_policy_before_and_after_binding() {
    let fixture = Fixture::new();
    let socket = fixture.0.join("agent");
    let _listener = listen(&socket);
    let mut transport = fixture.transport();
    fixture.pin();
    let baseline = record(&transport, "IdentityAgent=none");
    transport.bind_proof_agent(&socket).unwrap();
    let new_args = record(&transport, &format!("IdentityAgent={}", socket.display()));
    assert_eq!(baseline, new_args);
    let other = fixture.0.join("other");
    let _other_listener = listen(&other);
    assert_eq!(transport.bind_proof_agent(&other), Err(UNSUPPORTED));
    assert_eq!(
        record(&transport, &format!("IdentityAgent={}", socket.display())),
        baseline
    );
    fs::remove_file(fixture.0.join("known_hosts")).unwrap();
    assert!(matches!(
        transport.pinned_ssh("-T"),
        Err(ErrorCode::TrustRequired)
    ));
}

#[test]
fn configured_identity_agent_none_ignores_even_an_unreadable_bootstrap_hint() {
    let fixture = Fixture::new();
    fixture.pin();
    let mut transport = fixture.transport_with_policy(Some("none")).unwrap();
    transport
        .bind_proof_agent(Path::new("not-a-socket"))
        .unwrap();
    record(&transport, "IdentityAgent=none");
}

#[test]
fn configured_identity_agent_must_exist_at_startup_and_cannot_be_rebound() {
    let fixture = Fixture::new();
    fixture.pin();
    let socket = fixture.0.join("agent");
    let operand = socket.to_str().unwrap();
    assert!(matches!(
        fixture.transport_with_policy(Some(operand)),
        Err(UNSUPPORTED)
    ));
    let _listener = listen(&socket);
    let mut transport = fixture.transport_with_policy(Some(operand)).unwrap();
    record(&transport, &format!("IdentityAgent={operand}"));
    let other = fixture.0.join("other");
    let _other_listener = listen(&other);
    assert_eq!(transport.bind_proof_agent(&other), Err(UNSUPPORTED));
    assert_eq!(transport.bind_proof_agent(&socket), Ok(()));
    fs::rename(&socket, fixture.0.join("old-agent")).unwrap();
    let _replacement = listen(&socket);
    assert_eq!(transport.revalidate_policy(), Err(UNSUPPORTED));
    assert_refused(&transport);
}

#[test]
fn agent_identity_rejects_nonliteral_symlink_and_unsafe_socket_paths() {
    let fixture = Fixture::new();
    let socket = fixture.0.join("agent");
    let _listener = listen(&socket);
    let rejected = |path: &Path| assert!(matches!(ProofAgent::bind(path), Err(UNSUPPORTED)));
    rejected(Path::new("agent"));
    rejected(&fixture.0.join("./agent"));
    rejected(&fixture.0.join("%h"));
    rejected(&fixture.0.join("missing"));
    let file = fixture.0.join("file");
    fs::write(&file, b"not a socket").unwrap();
    chmod(&file, 0o600);
    rejected(&file);
    let link = fixture.0.join("link");
    symlink(&socket, &link).unwrap();
    rejected(&link);
    let parent_link = fixture.0.join("parent-link");
    symlink(&fixture.0, &parent_link).unwrap();
    rejected(&parent_link.join("agent"));
    chmod(&socket, 0o660);
    rejected(&socket);
    chmod(&socket, 0o600);
    chmod(&fixture.0, 0o755);
    rejected(&socket);
    let leaf = fixture.0.join("leaf");
    fs::DirBuilder::new().mode(0o700).create(&leaf).unwrap();
    let nested = leaf.join("agent");
    let _nested_listener = listen(&nested);
    chmod(&fixture.0, 0o777);
    rejected(&nested);
}

#[test]
fn agent_identity_rejects_replaced_socket_and_parent_before_launch() {
    let fixture = Fixture::new();
    let mut transport = fixture.transport();
    fixture.pin();
    let parent = fixture.0.join("private");
    fs::DirBuilder::new().mode(0o700).create(&parent).unwrap();
    let socket = parent.join("agent");
    let _listener = listen(&socket);
    transport.bind_proof_agent(&socket).unwrap();
    let expected = format!("IdentityAgent={}", socket.display());
    record(&transport, &expected);
    fs::rename(&socket, parent.join("old-agent")).unwrap();
    assert_refused(&transport);
    let _replacement_listener = listen(&socket);
    assert_refused(&transport);

    let mut transport = fixture.transport();
    transport.bind_proof_agent(&socket).unwrap();
    let saved_parent = fixture.0.join("saved");
    fs::rename(&parent, &saved_parent).unwrap();
    symlink(&saved_parent, &parent).unwrap();
    assert_refused(&transport);
    fs::remove_file(&parent).unwrap();
    fs::DirBuilder::new().mode(0o700).create(&parent).unwrap();
    fs::rename(saved_parent.join("agent"), &socket).unwrap();
    assert_refused(&transport);
}
