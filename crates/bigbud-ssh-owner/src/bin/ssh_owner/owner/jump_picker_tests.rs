//! Live, isolated two-daemon picker acceptance with private framed storage.

use super::*;
use crate::{
    owner_pipe::encode_payload,
    v1::{Empty, ListFolders, ProofStorageResult, ProofStorageSnapshot},
};
use bigbud_ssh_owner::framing::Endpoint;
use std::{env, fs, net::Ipv4Addr};

const TARGET: &str = "ssh:workspace";
const PROFILE: &[u8] = b"disposable-jump-picker";

#[test]
#[ignore = "requires the approved private Linux two-daemon fixture"]
fn bound_alias_browses_through_selected_owner_dispatch() {
    assert_eq!(
        env::var("BIGBUD_SSH_OWNER_LIVE_JUMP").as_deref(),
        Ok("approved-disposable")
    );
    let root = env::current_dir().unwrap();
    let lock_path = root.join("owner.lock");
    let _guard = crate::startup_bindings::lock_profile(&lock_path).unwrap();
    let mut input = Vec::new();
    for frame in [
        Payload::Hello(Hello {
            major: MAJOR,
            minor: MINOR,
            profile_binding: PROFILE.to_vec(),
            ..Hello::default()
        }),
        Payload::ProofStorageSnapshot(ProofStorageSnapshot {
            target_id: TARGET.into(),
            writer_epoch: "disposable-writer".into(),
            seq: 1,
            disconnected: false,
            error: 0,
        }),
    ] {
        Endpoint::Client
            .write_frame(&mut input, &encode_payload(frame))
            .unwrap();
    }
    let (mut owner, _) = bootstrap(
        &mut Pipe::new(input.as_slice(), Vec::new()),
        OwnerStartup {
            profile: PROFILE,
            startup: crate::owner::TargetStartup::Pinned {
                target: TARGET.into(),
                config: TransportConfig {
                    ssh: "/usr/bin/ssh".into(),
                    keyscan: "/usr/bin/ssh-keyscan".into(),
                    host: Ipv4Addr::LOCALHOST.into(),
                    port: 22223,
                    user: "picker".into(),
                    identity: root.join("d-identity"),
                    known_hosts: root.join("d-pins"),
                    alias_config: Some((root.join("ssh-config"), "workspace".into())),
                    system_config: None,
                    workspace_root: None,
                    dev_interactive_terminal: false,
                },
            },
            route_facts: Default::default(),
            profile_lock_path: &lock_path,
            posix_picker: None,
            workspace_snapshot_cancel: None,
            attach_path: None,
            agent_fixture: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            agent_service: None,
            identity_agent_path: None,
            stage: None,
            opencode_recipe: None,
            #[cfg(target_os = "linux")]
            opencode_service: None,
            #[cfg(target_os = "linux")]
            opencode_v2: None,
            tracked_push: None,
        },
    )
    .unwrap();
    let auth_count = |log| {
        fs::read_to_string(root.join(log))
            .unwrap()
            .matches("Accepted publickey")
            .count()
    };
    let initial = (auth_count("b.log"), auth_count("d.log"));
    let read = Operation::ListFolders(ListFolders::default());
    for id in 1..=2 {
        let Outcome::Folders(folders) = reply(&mut owner, id, read.clone(), None).unwrap() else {
            panic!("bound alias did not produce a folder result");
        };
        assert!(
            folders
                .entries
                .iter()
                .any(|folder| folder.name == "jump-fixture-folder")
        );
    }
    assert_eq!(
        (auth_count("b.log"), auth_count("d.log")),
        (initial.0 + 1, initial.1 + 1)
    );
    let generation = owner.generation;
    assert_eq!(
        owner
            .issue(request(
                &owner,
                3,
                Operation::InspectTrust(Default::default())
            ))
            .error,
        ErrorCode::OperationDenied as i32
    );
    assert!(matches!(
        reply(
            &mut owner,
            4,
            Operation::Disconnect(Empty::default()),
            Some(2)
        )
        .unwrap(),
        Outcome::Connection(_)
    ));
    assert_ne!(owner.generation, generation);
    crate::transport::posix_master::PosixMasterSlot::require_no_residual_lease(&root).unwrap();
    let mut stale = request(&owner, 5, read.clone());
    stale.target_generation = generation.to_vec();
    assert_eq!(owner.issue(stale).error, ErrorCode::StaleGeneration as i32);
    assert!(matches!(reply(&mut owner, 6, read.clone(), None).unwrap(),
        Outcome::Error(Error { code, .. }) if code == ErrorCode::TargetDisconnected as i32));
    assert_eq!(
        (auth_count("b.log"), auth_count("d.log")),
        (initial.0 + 1, initial.1 + 1)
    );
    assert!(matches!(
        reply(&mut owner, 7, Operation::Connect(Empty::default()), Some(3)).unwrap(),
        Outcome::Connection(_)
    ));
    assert!(matches!(
        reply(&mut owner, 8, read.clone(), None).unwrap(),
        Outcome::Folders(_)
    ));
    owner.retire_picker_master().unwrap();
    let pins = root.join("b-pins");
    let original_pin = fs::read(&pins).unwrap();
    let different_key = fs::read_to_string(root.join("d-pins")).unwrap();
    fs::write(&pins, different_key.replace(":22223 ", ":22222 ")).unwrap();
    for id in 9..=10 {
        let Outcome::Error(error) = reply(&mut owner, id, read.clone(), None).unwrap() else {
            panic!("expected a routed trust rejection");
        };
        assert_eq!(error.code, ErrorCode::HostKeyChanged as i32);
        let diagnostic = error.jump_failure.unwrap();
        assert_eq!(diagnostic.leg, 1);
        assert_eq!(diagnostic.stage, crate::v1::JumpStage::Handshake as i32);
    }
    fs::write(pins, original_pin).unwrap();
    assert_eq!(
        (auth_count("b.log"), auth_count("d.log")),
        (initial.0 + 2, initial.1 + 2)
    );
    owner.retire_picker_master().unwrap();
}

fn request(owner: &Owner, id: u8, operation: Operation) -> Request {
    Request {
        request_id: vec![id],
        target_id: TARGET.into(),
        target_generation: owner.generation.to_vec(),
        owner_epoch: owner.epoch.to_vec(),
        operation: Some(operation),
        ..Request::default()
    }
}

fn reply(owner: &mut Owner, id: u8, operation: Operation, seq: Option<u64>) -> RunResult<Outcome> {
    let mut req = request(owner, id, operation);
    let grant = owner.issue(req.clone());
    if grant.error != 0 {
        return Err(protocol_error().into());
    }
    req.grant = grant.grant;
    let mut input = Vec::new();
    if let Some(seq) = seq {
        let frame = Payload::ProofStorageResult(ProofStorageResult {
            request_id: vec![id],
            committed: true,
            seq,
            error: 0,
        });
        Endpoint::Client.write_frame(&mut input, &encode_payload(frame))?;
    }
    owner
        .request(&mut Pipe::new(input.as_slice(), Vec::new()), req)?
        .outcome
        .ok_or_else(|| protocol_error().into())
}
