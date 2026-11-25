#[path = "rebind_tests.live.rs"]
mod live;

use super::*;
use crate::{
    owner_pipe::{decode_payload, encode_payload},
    startup_bindings::PosixPickerFixture,
    v1::{ListFolders, ProofStorageSnapshot},
};
use bigbud_ssh_owner::framing::{Endpoint, FrameError};
use std::{fs, net::Ipv4Addr, os::unix::fs::DirBuilderExt, path::PathBuf};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> std::io::Result<Self> {
        let root = PathBuf::from(format!(
            "/private/tmp/bigbud-picker-sshd-rebind{}",
            std::process::id()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root)?;
        Ok(Self(root))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const TARGET: &str = "rebind-fixture";

#[test]
fn snapshot_fixture_scopes_cancellation_to_one_admitted_request() {
    use std::os::unix::net::UnixStream;

    let root = PathBuf::from(format!(
        "/private/tmp/bigbud-snapshot-sshd-owner{}",
        std::process::id()
    ));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let fixture = Fixture(root);
    let root = &fixture.0;
    let workspace = root.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let identity = crate::transport::write_identity_fixture(root);
    let known_hosts = root.join("known_hosts");
    let profile_lock_path = &root.join("owner.lock");
    let validate = |workspace: &std::path::Path| {
        crate::startup_bindings::validate_snapshot_fixture(
            &identity,
            &known_hosts,
            profile_lock_path,
            Some(workspace),
            None,
            false,
        )
    };
    validate(&workspace).expect("private workspace admits fixture startup");
    assert!(validate(root).is_err());

    let (reader, mut writer) = UnixStream::pair().unwrap();
    reader.set_nonblocking(true).unwrap();
    let profile = b"snapshot-cancel-profile";
    let initial = input([
        Payload::Hello(Hello {
            major: MAJOR,
            minor: MINOR,
            profile_binding: profile.to_vec(),
            ..Hello::default()
        }),
        snapshot("snapshot-writer"),
    ])
    .unwrap();
    let mut pipe = Pipe::new(initial.as_slice(), Vec::new());
    let (mut owner, _) = bootstrap(
        &mut pipe,
        OwnerStartup {
            profile,
            startup: crate::owner::TargetStartup::Pinned {
                target: TARGET.into(),
                config: TransportConfig {
                    ssh: "/usr/bin/ssh".into(),
                    keyscan: "/usr/bin/ssh-keyscan".into(),
                    host: Ipv4Addr::LOCALHOST.into(),
                    port: 2200,
                    user: "fixture".into(),
                    identity,
                    known_hosts,
                    alias_config: None,
                    system_config: None,
                    workspace_root: Some(workspace.clone()),
                    dev_interactive_terminal: false,
                },
            },
            route_facts: Default::default(),
            profile_lock_path,
            posix_picker: None,
            workspace_snapshot_cancel: Some(SnapshotCancelInbox::new(reader.into())),
            attach_path: None,
            agent_fixture: None,
            identity_agent_path: None,
            stage: None,
        },
    )
    .unwrap();
    let mut request = Request {
        request_id: vec![2; 16],
        target_id: TARGET.into(),
        owner_epoch: owner.epoch.to_vec(),
        target_generation: owner.generation.to_vec(),
        operation: Some(Operation::ListFolders(ListFolders::default())),
        ..Request::default()
    };
    assert_eq!(
        owner.validate(&request).err(),
        Some(ErrorCode::OperationDenied)
    );
    request.operation = Some(Operation::ProofWorkspaceSnapshot(
        crate::v1::ProofWorkspaceList {
            workspace_root: workspace.to_str().unwrap().into(),
            relative_dir: String::new(),
        },
    ));
    let generation = std::mem::take(&mut request.target_generation);
    assert_eq!(
        owner.validate(&request).err(),
        Some(ErrorCode::StaleGeneration)
    );
    request.target_generation = generation;
    request.request_id.pop();
    assert_eq!(
        owner.validate(&request).err(),
        Some(ErrorCode::InvalidOperands)
    );
    request.request_id.push(2);
    let mut execute = |owner: &mut Owner, request: &Request| {
        let operation = owner.validate(request).unwrap();
        owner
            .execute(&mut pipe, &request.request_id, operation)
            .unwrap()
            .err()
    };
    writer.write_all(&[2; 16]).unwrap();
    assert_eq!(
        execute(&mut owner, &request),
        Some(ErrorCode::ListCancelled)
    );
    // A duplicate late cancel must not hit a different subscriber's read.
    writer.write_all(&[2; 16]).unwrap();
    request.request_id = vec![3; 16];
    assert_eq!(
        execute(&mut owner, &request),
        Some(ErrorCode::TrustRequired)
    );
    assert_eq!(owner.epoch.as_slice(), request.owner_epoch);
    assert_eq!(owner.generation.as_slice(), request.target_generation);
}

fn input(frames: impl IntoIterator<Item = Payload>) -> Result<Vec<u8>, FrameError> {
    let mut bytes = Vec::new();
    for frame in frames {
        Endpoint::Client.write_frame(&mut bytes, &encode_payload(frame))?;
    }
    Ok(bytes)
}

fn snapshot(writer: &str) -> Payload {
    Payload::ProofStorageSnapshot(ProofStorageSnapshot {
        target_id: TARGET.into(),
        writer_epoch: writer.into(),
        seq: 1,
        disconnected: false,
        error: 0,
    })
}

#[test]
fn connected_rebind_fences_old_requests_without_stranding_posix_picker() {
    let fixture = Fixture::new().expect("private rebind fixture directory");
    let root = &fixture.0;
    let profile = b"rebind-profile";
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
            startup: crate::owner::TargetStartup::Pinned {
                target: TARGET.into(),
                config: TransportConfig {
                    ssh: "/usr/bin/ssh".into(),
                    keyscan: "/usr/bin/ssh-keyscan".into(),
                    host: Ipv4Addr::LOCALHOST.into(),
                    port: 2200,
                    user: "fixture".into(),
                    identity: crate::transport::write_identity_fixture(root),
                    known_hosts: root.join("known_hosts"),
                    alias_config: None,
                    system_config: None,
                    workspace_root: None,
                    dev_interactive_terminal: false,
                },
            },
            route_facts: Default::default(),
            profile_lock_path: &root.join("owner.lock"),
            posix_picker: Some(PosixPickerFixture::Key),
            workspace_snapshot_cancel: None,
            attach_path: None,
            agent_fixture: None,
            identity_agent_path: None,
            stage: None,
        },
    )
    .unwrap();
    let old_generation = owner.generation;
    let mut read = Request {
        request_id: vec![1],
        target_id: TARGET.into(),
        owner_epoch: owner.epoch.to_vec(),
        target_generation: old_generation.to_vec(),
        operation: Some(Operation::ListFolders(ListFolders::default())),
        ..Request::default()
    };
    assert!(owner.validate(&read).is_ok());
    // Enter picker admission while forbidding any transport launch, even if a
    // future test fixture happens to have a trusted endpoint.
    let list_without_transport = |owner: &mut Owner, read: &Request| {
        owner
            .validate(read)
            .and_then(|_| owner.list_picker_folders(&read.request_id, Some("\0")))
            .map(drop)
    };
    assert_eq!(
        list_without_transport(&mut owner, &read),
        Err(ErrorCode::InvalidOperands)
    );

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
    assert_eq!(accepted.owner_epoch, read.owner_epoch);
    assert_ne!(accepted.proof_target_generation, old_generation);
    assert_eq!(
        list_without_transport(&mut owner, &read),
        Err(ErrorCode::StaleGeneration)
    );
    read.target_generation = accepted.proof_target_generation;
    assert_eq!(
        list_without_transport(&mut owner, &read),
        Err(ErrorCode::InvalidOperands)
    );
}
