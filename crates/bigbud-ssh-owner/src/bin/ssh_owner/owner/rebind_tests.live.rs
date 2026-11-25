use super::*;
use std::{env, path::Path};

#[test]
#[ignore = "requires an explicitly selected disposable macOS loopback sshd"]
fn live_picker_master_retires_before_storage_rebind_acknowledgement() {
    assert_eq!(
        env::var("BIGBUD_POSIX_MASTER_FIXTURE").as_deref(),
        Ok("approved-disposable")
    );
    let root = PathBuf::from(env::var_os("BIGBUD_POSIX_MASTER_FIXTURE_ROOT").unwrap());
    assert_eq!(root.parent(), Some(Path::new("/private/tmp")));
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("bigbud-picker-sshd-")
    );
    let port: u16 = env::var("BIGBUD_POSIX_MASTER_FIXTURE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    assert!(port >= 1024);
    let user = env::var("BIGBUD_POSIX_MASTER_FIXTURE_USER").unwrap();
    let public = fs::read_to_string(root.join("host-key.pub")).unwrap();
    let mut fields = public.split_ascii_whitespace();
    let key_type = fields.next().unwrap();
    let key = fields.next().unwrap();
    assert_eq!(
        fs::read_to_string(root.join("known_hosts")).unwrap(),
        format!("[127.0.0.1]:{port} {key_type} {key}\n")
    );
    let profile = b"rebind-live-profile";
    let initial = input([
        Payload::Hello(Hello {
            major: MAJOR,
            minor: MINOR,
            profile_binding: profile.to_vec(),
            ..Hello::default()
        }),
        snapshot("writer-a"),
    ])
    .expect("initial owner frames");
    let (mut owner, _) = bootstrap(
        &mut Pipe::new(initial.as_slice(), Vec::new()),
        OwnerStartup {
            profile,
            target: TARGET.into(),
            config: TransportConfig {
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
            },
            route_facts: Default::default(),
            profile_lock_path: &root.join("owner.lock"),
            posix_picker: Some(PosixPickerFixture::Key),
            workspace_snapshot_cancel: None,
            // Exercise the internal rebind without widening supported bootstrap combinations.
            attach_path: None,
            agent_fixture: None,
            identity_agent_path: None,
            stage: None,
        },
    )
    .unwrap();

    let live_leases = || {
        fs::read_dir(&root)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("bbcm-"))
            .map(|entry| entry.path())
            .collect::<Vec<_>>()
    };
    let mut request = Request {
        request_id: vec![1],
        target_id: TARGET.into(),
        owner_epoch: owner.epoch.to_vec(),
        target_generation: owner.generation.to_vec(),
        operation: Some(Operation::ListFolders(ListFolders::default())),
        ..Request::default()
    };
    let read = |owner: &mut Owner, request: &Request| {
        owner.validate(request).and_then(|_| {
            owner.list_picker_folders(&request.request_id, Some("~/picker's folders; literal"))
        })
    };
    read(&mut owner, &request).expect("first authenticated list");
    let before = live_leases();
    assert_eq!(before.len(), 1);
    assert!(before[0].join("s").exists());

    let incoming = input([snapshot("writer-b")]).expect("storage handoff frame");
    let mut outgoing = Vec::new();
    owner.park();
    owner
        .rebind(&mut Pipe::new(incoming.as_slice(), &mut outgoing))
        .unwrap();
    let mut replies = outgoing.as_slice();
    let mut receive = || {
        let bytes = Endpoint::Client.read_frame(&mut replies).unwrap().unwrap();
        decode_payload(&bytes).unwrap()
    };
    assert!(matches!(receive(), Payload::ProofStorageHydrate(_)));
    let Payload::HelloAccepted(accepted) = receive() else {
        panic!("missing rebind acknowledgement");
    };
    assert_eq!(accepted.owner_epoch, request.owner_epoch);
    assert!(
        live_leases().is_empty(),
        "old lease must be retired at acknowledgement"
    );
    assert!(matches!(
        read(&mut owner, &request),
        Err(ErrorCode::StaleGeneration)
    ));
    assert!(
        live_leases().is_empty(),
        "old request must not open a lease"
    );
    request.target_generation = accepted.proof_target_generation;
    read(&mut owner, &request).expect("authenticated list in new generation");
    let after = live_leases();
    assert_eq!(after.len(), 1);
    assert_ne!(after, before);
    owner.retire_picker_master().unwrap();
    assert!(live_leases().is_empty());
}
