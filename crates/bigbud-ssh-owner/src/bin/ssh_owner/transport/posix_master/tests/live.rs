use super::*;
use std::env;
use std::path::PathBuf;

// These live tests use only the disposable macOS picker sshd fixture with its
// generated host public key pinned explicitly, never an existing SSH service.
fn live_fixture() -> (PathBuf, Transport) {
    assert_eq!(
        env::var("BIGBUD_POSIX_MASTER_FIXTURE").as_deref(),
        Ok("approved-disposable")
    );
    let root =
        PathBuf::from(env::var_os("BIGBUD_POSIX_MASTER_FIXTURE_ROOT").expect("fixture root"));
    assert_eq!(root.parent(), Some(Path::new("/private/tmp")));
    assert!(
        root.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("bigbud-picker-sshd-"))
    );
    let port = env::var("BIGBUD_POSIX_MASTER_FIXTURE_PORT")
        .expect("fixture port")
        .parse::<u16>()
        .expect("numeric fixture port");
    assert!(port >= 1024);
    let user = env::var("BIGBUD_POSIX_MASTER_FIXTURE_USER").expect("fixture user");
    let transport = Transport::new(TransportConfig {
        ssh: SSH.into(),
        keyscan: "/usr/bin/ssh-keyscan".into(),
        host: std::net::Ipv4Addr::LOCALHOST.into(),
        port,
        user,
        identity: root.join("identity"),
        known_hosts: root.join("known_hosts"),
        alias_config: None,
        system_config: None,
        workspace_root: None,
        dev_interactive_terminal: false,
    })
    .expect("fixture transport");
    let public = fs::read_to_string(root.join("host-key.pub")).expect("generated host public key");
    let mut fields = public.split_ascii_whitespace();
    let key_type = fields.next().expect("fixture key type");
    let key = fields.next().expect("fixture key blob");
    let expected = format!("[127.0.0.1]:{port} {key_type} {key}\n");
    assert!(
        fs::read_to_string(&transport.config.known_hosts).expect("explicit fixture pin")
            == expected
    );
    (root, transport)
}

#[test]
#[ignore = "requires a separately approved, running throwaway loopback sshd with generated keys"]
fn stock_master_is_checked_reaped_and_does_not_adopt_an_outside_master() {
    let (_, transport) = live_fixture();
    // Launch an independent stock client first. Its tracked child is used by
    // the test harness for cleanup only, never registered in the slot under test.
    let mut outside = launch_outside(&transport);
    outside
        .master
        .as_mut()
        .unwrap()
        .verify(Instant::now() + CHECK_LIMIT)
        .expect("outside master ready");
    let outside_id = outside.master.as_mut().unwrap().live_pid().unwrap();
    let outside_socket = outside.master.as_ref().unwrap().paths.socket.clone();

    let mut slot = PosixMasterSlot::default();
    slot.open_fixture(&transport, GEN)
        .expect("owned master launch");
    let owned = slot.master.as_mut().unwrap();
    let owned_id = owned.live_pid().unwrap();
    let owned_socket = owned.paths.socket.clone();
    assert_ne!(owned_id, outside_id);
    assert_ne!(owned_socket, outside_socket);
    slot.open_fixture(&transport, GEN)
        .expect("same generation coalesces");
    assert_eq!(slot.master.as_mut().unwrap().live_pid().unwrap(), owned_id);
    assert_eq!(
        slot.check(&transport, STALE),
        Err(ErrorCode::StaleGeneration)
    );
    slot.invalidate(GEN).expect("checked reap");
    assert!(slot.master.is_none());
    assert!(!owned_socket.parent().expect("owned directory").exists());
    assert!(outside_socket.exists());
    outside
        .master
        .as_mut()
        .unwrap()
        .verify(Instant::now() + CHECK_LIMIT)
        .expect("outside still live");
    outside
        .invalidate(GEN)
        .expect("test harness reaps outside fixture");
}

#[test]
#[ignore = "requires a separately approved, running throwaway loopback sshd with generated keys"]
fn stock_master_retirement_requires_checked_reap_before_replacement() {
    let (root, transport) = live_fixture();
    let mut outside = launch_outside(&transport);
    let outside_master = outside.master.as_mut().expect("outside lease");
    let outside_stamp = outside_master.socket.expect("verified outside stamp");

    let mut slot = PosixMasterSlot::default();
    let open = |slot: &mut PosixMasterSlot, generation| {
        slot.open_before(&transport, generation, Instant::now() + READY_LIMIT, || {
            PrivatePaths::new_in(&root)
        })
    };
    open(&mut slot, GEN).expect("verified owned lease");
    assert_eq!(
        slot.check(&transport, STALE),
        Err(ErrorCode::StaleGeneration)
    );
    assert_eq!(slot.invalidate(STALE), Err(ErrorCode::StaleGeneration));
    let owned = slot.master.as_mut().expect("stale work leaves lease owned");
    let retained_pid = owned.live_pid().expect("retained child still live");
    assert!(matches!(
        probe::connect_owned(
            &outside_master.paths.socket,
            retained_pid,
            Instant::now() + CHECK_LIMIT,
        ),
        Err(UNAVAILABLE)
    ));
    owned
        .verify(Instant::now() + CHECK_LIMIT)
        .expect("owned kernel peer still answers mux");
    let socket = owned.paths.socket.clone();
    let directory = socket.parent().expect("owned directory");
    let stamp = owned.socket.expect("verified owned stamp");

    // Simulate a dead foreground OpenSSH without consuming its wait status or
    // removing its socket. Only the slot may reap the retained child.
    owned.child.as_mut().expect("exact child").kill().unwrap();
    let deadline = Instant::now() + REAP_LIMIT;
    while !has_waitable_exit() {
        assert!(Instant::now() < deadline, "killed child did not exit");
        pause(deadline);
    }
    assert!(owned.child.is_some());
    assert!(owned.paths.observe().unwrap() == Some(stamp));

    let mut replacement = PosixMasterSlot::default();
    assert_eq!(open(&mut replacement, STALE), Err(UNAVAILABLE));
    assert!(replacement.master.is_none());

    // Even after reaping, uncertain directory evidence must leave the lease
    // fenced. Restore the test mutation before asserting, including on failure.
    fs::set_permissions(directory, fs::Permissions::from_mode(0o755)).unwrap();
    let uncertain = slot.invalidate(GEN);
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(uncertain, Err(UNAVAILABLE));
    let blocked = slot.master.as_ref().expect("uncertainty retains slot");
    assert!(blocked.closing && blocked.child.is_none());
    assert!(
        !has_waitable_exit(),
        "the kernel must confirm reap, not just handle drop"
    );
    assert!(blocked.paths.observe().unwrap() == Some(stamp));
    assert_eq!(open(&mut replacement, STALE), Err(UNAVAILABLE));
    assert!(replacement.master.is_none());

    slot.invalidate(GEN).expect("finish checked retirement");
    assert!(slot.master.is_none());
    assert!(!directory.exists());
    assert_eq!(PosixMasterSlot::require_no_residual_lease(&root), Ok(()));
    open(&mut replacement, STALE).expect("new verified lease after retirement");
    replacement
        .check(&transport, STALE)
        .expect("replacement kernel peer answers mux");
    replacement.invalidate(STALE).expect("reap replacement");

    assert!(outside_master.paths.observe().unwrap() == Some(outside_stamp));
    outside_master
        .verify(Instant::now() + CHECK_LIMIT)
        .expect("outside kernel peer and mux still live");
    outside
        .invalidate(GEN)
        .expect("harness reaps outside child");
}

// The driver runs this case alone. At each observation its only other child
// is the independently verified, still-live outside OpenSSH. WNOWAIT examines
// this process's own child statuses without selecting or reaping by PID.
fn has_waitable_exit() -> bool {
    // SAFETY: siginfo_t is C storage and waitid receives a valid writable
    // pointer; zero initialization also represents no event for WNOHANG.
    let mut status: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: P_ALL with id zero selects only this caller's children, and the
    // initialized status lives through the call.
    let result = unsafe {
        libc::waitid(
            libc::P_ALL,
            0,
            &mut status,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    assert_eq!(result, 0, "waitid: {}", std::io::Error::last_os_error());
    status.si_signo == libc::SIGCHLD
}

fn launch_outside(transport: &Transport) -> PosixMasterSlot {
    let pinned = transport
        .pinned_ssh("-T")
        .expect("pin outside command independently");
    let paths = PrivatePaths::new().expect("independent socket directory");
    let mut outside = PosixMasterSlot {
        master: Some(Master {
            binding: Binding {
                generation: GEN,
                scope: Arc::clone(&transport.config),
                key: transport
                    .pin()
                    .expect("read fixture pin")
                    .expect("approved fixture pin")
                    .key,
                executable: validate_fixture(transport).expect("fixture executable"),
                password: false,
            },
            child: Some(
                master_command(&pinned, &paths.socket, transport.host(), &[])
                    .spawn()
                    .expect("independent stock client"),
            ),
            connector: None,
            recovery: None,
            socket: None,
            paths,
            closing: false,
            retirement: None,
            master_record: None,
            connector_record: None,
            _pin: pinned._snapshot,
        }),
        retirement: None,
    };
    outside
        .master
        .as_mut()
        .unwrap()
        .await_ready(Instant::now() + READY_LIMIT)
        .expect("outside ready");
    outside
}
