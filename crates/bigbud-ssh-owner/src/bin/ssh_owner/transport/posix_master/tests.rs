#[cfg(target_os = "macos")]
mod cancellation;
#[cfg(target_os = "macos")]
mod live;
#[cfg(target_os = "linux")]
mod live_jump;

use super::*;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};

const GEN: Token = [1; 32];
const STALE: Token = [2; 32];
const PIN: &str = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
const DIFFERENT_PIN: &str = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB\n";

pub(super) struct Fixture {
    root: PrivatePaths,
    pub(super) transport: Transport,
}

impl Fixture {
    pub(super) fn new() -> Self {
        let root = PrivatePaths::new().expect("private fixture");
        let parent = root.socket.parent().expect("fixture parent");
        let known_hosts = parent.join("known_hosts");
        fs::write(&known_hosts, PIN).expect("synthetic pin");
        fs::set_permissions(&known_hosts, fs::Permissions::from_mode(0o600)).expect("private pin");
        let transport = Transport::new(TransportConfig {
            ssh: SSH.into(),
            keyscan: "/usr/bin/ssh-keyscan".into(),
            host: std::net::Ipv4Addr::LOCALHOST.into(),
            port: 2200,
            user: "fixture".to_owned(),
            identity: super::super::write_identity_fixture(parent),
            known_hosts,
            alias_config: None,
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
            host_identity: Default::default(),
        })
        .expect("fixture transport");
        Self { root, transport }
    }

    fn sleeping_slot(&self) -> PosixMasterSlot {
        let child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("synthetic retained child");
        PosixMasterSlot {
            master: Some(Master {
                binding: Binding {
                    generation: GEN,
                    scope: Arc::clone(&self.transport.config),
                    key: self.transport.pin().expect("pin read").expect("pin").key,
                    executable: validate_fixture(&self.transport).expect("fixture binding"),
                    password: false,
                    production: false,
                },
                paths: PrivatePaths::new().expect("new master directory"),
                child: Some(child),
                death_watch: None,
                connector: None,
                recovery: None,
                socket: None,
                closing: false,
                retirement: None,
                master_record: None,
                connector_record: None,
                published: None,
                _pin: self
                    .transport
                    .pinned_ssh("-T")
                    .expect("test snapshot")
                    ._snapshot,
            }),
            retirement: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(self.root.socket.parent().expect("fixture parent"))
            .expect("clean fixture");
    }
}

#[test]
fn password_and_key_leases_cannot_cross_auth_modes_or_generations() {
    let fixture = Fixture::new();
    let mut slot = fixture.sleeping_slot();
    let deadline = Instant::now() + READY_LIMIT;
    assert!(matches!(
        slot.list_unlocked_folders(&fixture.transport, GEN, None, deadline),
        Err(ErrorCode::OperationDenied)
    ));
    slot.master.as_mut().unwrap().binding.password = true;
    assert!(matches!(
        slot.open_and_list_folders(&fixture.transport, GEN, None, deadline),
        Err(ErrorCode::OperationDenied)
    ));
    let mut password = *b"synthetic";
    assert_eq!(
        slot.unlock_password(&fixture.transport, STALE, &mut password, deadline),
        Err(ErrorCode::StaleGeneration)
    );
    assert!(password.iter().all(|&byte| byte == 0));
    assert!(slot.master.as_mut().unwrap().live_pid().is_ok());
    slot.invalidate(GEN).unwrap();
}

fn list_error(slot: &mut PosixMasterSlot, transport: &Transport, generation: Token) -> ErrorCode {
    slot.open_and_list_folders(transport, generation, None, Instant::now() + READY_LIMIT)
        .expect_err("picker must fail before use")
}

#[test]
fn routed_socket_uses_and_retains_the_private_fixture_parent() {
    let fixture = Fixture::new();
    let parent = fixture.root.socket.parent().expect("fixture parent");
    let paths = PrivatePaths::new_in(parent).expect("nested socket directory");
    let directory = paths.socket.parent().expect("socket parent");
    assert_eq!(directory.parent(), Some(parent));
    let suffix = directory
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("bbcm-"))
        .expect("sandbox-allowlisted basename");
    assert_eq!(suffix.len(), 12);
    assert!(suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()));
    assert_eq!(paths.socket.file_name(), Some(std::ffi::OsStr::new("s")));
    assert!(matches!(paths.observe(), Ok(None)));
    fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).expect("untrust parent");
    assert!(matches!(paths.observe(), Err(UNAVAILABLE)));
    assert!(matches!(PrivatePaths::new_in(parent), Err(UNAVAILABLE)));
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).expect("restore fixture mode");
    paths.remove(None).expect("checked directory cleanup");
}

#[test]
fn reserved_directory_blocks_replacement_until_checked_cleanup() {
    let fixture = Fixture::new();
    let root = fixture.root.socket.parent().expect("fixture root");
    let reserved = PrivatePaths::new_in(root).expect("reserve before spawning");
    assert_eq!(paths::require_no_residual_lease(root), Err(UNAVAILABLE));
    assert!(matches!(PrivatePaths::new_in(root), Err(UNAVAILABLE)));
    reserved
        .remove(None)
        .expect("checked cleanup without a child");
    assert_eq!(paths::require_no_residual_lease(root), Ok(()));
}

#[test]
fn malformed_operand_and_expired_budget_do_not_establish_a_lease() {
    let fixture = Fixture::new();
    let mut slot = PosixMasterSlot::default();
    assert!(matches!(
        slot.open_and_list_folders(
            &fixture.transport,
            GEN,
            Some("bad\0path"),
            Instant::now() + READY_LIMIT
        ),
        Err(ErrorCode::InvalidOperands)
    ));
    assert!(matches!(
        slot.open_and_list_folders(&fixture.transport, GEN, None, Instant::now()),
        Err(ErrorCode::ListTimedOut)
    ));
    assert!(slot.master.is_none());
}

#[test]
fn stale_or_different_binding_does_not_reap_the_active_child() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let mut slot = fixture.sleeping_slot();
    let pid = slot.master.as_mut().unwrap().live_pid().unwrap();
    assert_eq!(
        list_error(&mut slot, &fixture.transport, STALE),
        ErrorCode::StaleGeneration
    );
    assert_eq!(slot.invalidate(STALE), Err(ErrorCode::StaleGeneration));
    assert_eq!(
        list_error(&mut slot, &other.transport, GEN),
        ErrorCode::OperationDenied
    );
    assert_eq!(slot.master.as_mut().unwrap().live_pid(), Ok(pid));
    slot.invalidate(GEN).expect("reap retained child");
    assert!(slot.master.is_none());
}

#[test]
fn changed_or_removed_pin_revokes_the_active_master() {
    for (material, expected) in [
        (DIFFERENT_PIN, ErrorCode::HostKeyChanged),
        ("", ErrorCode::TrustRequired),
    ] {
        let fixture = Fixture::new();
        let mut slot = fixture.sleeping_slot();
        fs::write(&fixture.transport.config.known_hosts, material).expect("replace fixture pin");
        assert_eq!(list_error(&mut slot, &fixture.transport, GEN), expected);
        assert!(slot.master.is_none());
    }
}

#[test]
fn replacing_identity_revokes_the_active_master() {
    let fixture = Fixture::new();
    let mut slot = fixture.sleeping_slot();
    fs::write(&fixture.transport.config.identity, "new synthetic identity").expect("change key");
    assert_eq!(
        list_error(&mut slot, &fixture.transport, GEN),
        ErrorCode::ConfigUnsupported
    );
    assert!(slot.master.is_none());
}

#[test]
fn different_socket_peer_gets_no_mux_request_and_blocks_cleanup() {
    let fixture = Fixture::new();
    let mut slot = fixture.sleeping_slot();
    let path = slot.master.as_ref().unwrap().paths.socket.clone();
    let outside = UnixListener::bind(&path).expect("bind outside socket");
    let mode = fs::Permissions::from_mode(0o600);
    fs::set_permissions(&path, mode).expect("simulate watchable socket");
    let original = fs::symlink_metadata(&path).unwrap().ino();

    assert_eq!(list_error(&mut slot, &fixture.transport, GEN), UNAVAILABLE);
    assert_eq!(slot.open_fixture(&fixture.transport, GEN), Err(UNAVAILABLE));
    let blocked = slot
        .master
        .as_ref()
        .expect("uncertain cleanup retains slot");
    assert!(blocked.closing && blocked.child.is_none());
    assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), original);
    outside.set_nonblocking(true).expect("bound test accept");
    let (mut attempted, _) = outside.accept().expect("kernel peer check connected");
    attempted.set_nonblocking(true).expect("bound test read");
    assert_eq!(
        attempted.read(&mut [0; 1]).unwrap(),
        0,
        "outside received no mux frames"
    );

    fs::remove_file(path).expect("remove our outside test socket");
    slot.invalidate(GEN)
        .expect("finish cleanup after outside test removes its socket");
}

#[test]
fn live_probe_has_a_bounded_response_deadline() {
    let (local, _silent) = UnixStream::pair().expect("synthetic mux socket");
    local.set_nonblocking(true).expect("nonblocking check");
    let start = Instant::now();
    let deadline = start + Duration::from_millis(40);
    assert_eq!(
        probe::alive(&local, std::process::id(), deadline),
        Err(LOST)
    );
    assert!(Instant::now() >= deadline);
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn owned_launch_does_not_inherit_the_ambient_agent_socket() {
    let fixture = Fixture::new();
    let pinned = fixture.transport.pinned_ssh("-T").expect("pinned command");
    let command = master_command(&pinned, &fixture.root.socket, fixture.transport.host(), &[]);
    // The owner carries agent policy explicitly; a child never inherits the UI process env.
    assert!(!command.get_envs().any(|(key, _)| key == "SSH_AUTH_SOCK"));
    assert_eq!(command.get_envs().count(), 1);
}

#[test]
fn effective_stock_ssh_options_are_fixture_only() {
    let fixture = Fixture::new();
    let pinned = fixture.transport.pinned_ssh("-T").expect("pinned command");
    let master = master_command(&pinned, &fixture.root.socket, fixture.transport.host(), &[]);
    let result = Command::new(SSH)
        .arg("-G") // Effective-config inspection only; no network.
        .args(master.get_args())
        .env_clear()
        .env("LC_ALL", "C")
        .output()
        .expect("inspect stock SSH options");
    assert!(result.status.success());
    let effective = String::from_utf8(result.stdout).expect("effective options text");
    for option in [
        "controlmaster true",
        "controlpersist no",
        "sessiontype none",
        "stricthostkeychecking true",
        "identityagent none",
        "passwordauthentication no",
        "kbdinteractiveauthentication no",
        "forwardagent no",
        "clearallforwardings yes",
    ] {
        assert!(
            effective.lines().any(|line| line == option),
            "missing {option}"
        );
    }
    let control_path = format!("controlpath {}", fixture.root.socket.display());
    assert!(effective.lines().any(|line| line == control_path));
}
