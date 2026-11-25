use super::*;
use crate::owner::{OwnerStartup, bootstrap};
use crate::owner_pipe::encode_payload;
use crate::v1::{Hello, ProofStorageSnapshot};
use bigbud_ssh_owner::framing::Endpoint;
use std::{
    fs,
    io::{self, Write},
    net::Ipv4Addr,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::PathBuf,
};

pub(super) type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
const TARGET: &str = "guarded-stage-fixture";
pub(super) const BODY: &[u8] = b"\xef\xbb\xbfnew text\r\n";
#[cfg(target_os = "macos")]
const PREFIX: &str = "/private/tmp/bigbud-picker-sshd-";
#[cfg(target_os = "linux")]
const PREFIX: &str = "/tmp/bigbud-picker-linux-";

pub(super) struct Fixture(pub(super) PathBuf);

impl Fixture {
    pub(super) fn new(suffix: &str) -> TestResult<Self> {
        let root = PathBuf::from(format!(
            "{PREFIX}guardedstage{}{suffix}",
            std::process::id()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root)?;
        let fixture = Self(root);
        let recorder = fixture.0.join("recorder");
        fs::write(&recorder, b"#!/bin/sh\n: > \"$0.called\"\nexit 97\n")?;
        fs::set_permissions(&recorder, fs::Permissions::from_mode(0o700))?;
        Ok(fixture)
    }

    pub(super) fn workspace(&self) -> PathBuf {
        self.0.join("home/picker's folders; literal")
    }

    pub(super) fn config(&self) -> crate::transport::TransportConfig {
        crate::transport::TransportConfig {
            ssh: self.0.join("recorder"),
            keyscan: self.0.join("recorder"),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 22222,
            user: "picker".into(),
            identity: self.0.join("identity"),
            known_hosts: self.0.join("known_hosts"),
            alias_config: None,
            system_config: None,
            workspace_root: Some(self.workspace()),
            dev_interactive_terminal: cfg!(target_os = "macos"),
        }
    }

    pub(super) fn owner(&self) -> TestResult<Owner> {
        let mut config = self.config();
        config.identity = crate::transport::write_identity_fixture(&self.0);
        self.owner_with(config)
    }

    pub(super) fn owner_with(
        &self,
        config: crate::transport::TransportConfig,
    ) -> TestResult<Owner> {
        let initial = frames([
            Payload::Hello(Hello {
                major: 1,
                profile_binding: vec![1],
                ..Hello::default()
            }),
            snapshot(1, false),
        ])?;
        let (owner, _) = bootstrap(
            &mut Pipe::new(initial.as_slice(), Vec::new()),
            OwnerStartup {
                profile: &[1],
                startup: crate::owner::TargetStartup::Pinned {
                    target: TARGET.into(),
                    config,
                },
                route_facts: Default::default(),
                profile_lock_path: &self.0.join("owner.lock"),
                posix_picker: None,
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                workspace_snapshot_cancel: None,
                attach_path: None,
                agent_fixture: None,
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                agent_service: None,
                identity_agent_path: None,
                stage: None,
                #[cfg(target_os = "linux")]
                tracked_push: None,
                #[cfg(target_os = "linux")]
                opencode_recipe: None,
                #[cfg(target_os = "linux")]
                opencode_service: None,
            },
        )?;
        Ok(owner)
    }

    pub(super) fn enable(&self, owner: &mut Owner) {
        owner.guarded_write = GuardedWrite::for_fixture(
            true,
            &self.config(),
            &self.0.join("owner.lock"),
            owner.generation,
        );
        assert!(owner.guarded_write.is_some());
    }

    pub(super) fn binding(&self, id: &str) -> ProofWorkspaceGuardedWriteBinding {
        ProofWorkspaceGuardedWriteBinding {
            operation_id: id.into(),
            workspace_root: self.workspace().to_string_lossy().into_owned(),
            relative_path: "edit.txt".into(),
            expected_sha256: Sha256::digest(b"base").to_vec(),
            attempted_sha256: Sha256::digest(BODY).to_vec(),
            body_bytes: u32::try_from(BODY.len()).ok(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn snapshot(seq: u64, disconnected: bool) -> Payload {
    Payload::ProofStorageSnapshot(ProofStorageSnapshot {
        target_id: TARGET.into(),
        writer_epoch: "writer".into(),
        seq,
        disconnected,
        error: 0,
    })
}

pub(super) fn frames(payloads: impl IntoIterator<Item = Payload>) -> TestResult<Vec<u8>> {
    let mut input = Vec::new();
    for payload in payloads {
        Endpoint::Client.write_frame(&mut input, &encode_payload(payload))?;
    }
    Ok(input)
}

pub(super) fn request(owner: &Owner, id: u8, operation: Operation) -> Request {
    Request {
        request_id: vec![id],
        target_id: TARGET.into(),
        target_generation: owner.generation.to_vec(),
        owner_epoch: owner.epoch.to_vec(),
        operation: Some(operation),
        ..Request::default()
    }
}

pub(super) fn grant(owner: &mut Owner, id: u8, operation: Operation) -> Request {
    let mut request = request(owner, id, operation);
    let reply = owner.issue(request.clone());
    assert_eq!(reply.error, i32::from(ErrorCode::Unspecified));
    assert_eq!(reply.grant.len(), 32);
    request.grant = reply.grant;
    request
}

pub(super) fn send(owner: &mut Owner, id: u8, operation: Operation) -> TestResult<Reply> {
    let request = grant(owner, id, operation);
    owner.request(&mut Pipe::new(&[][..], Vec::new()), request)
}

pub(super) fn assert_error(reply: Reply, expected: ErrorCode) {
    assert!(
        matches!(reply.outcome, Some(Outcome::Error(ref err)) if err.code == i32::from(expected)),
        "{reply:?}"
    );
}

pub(super) fn stage_outcome(reply: Reply) -> Option<result::Outcome> {
    match reply.outcome {
        Some(Outcome::ProofWorkspaceGuardedWriteStage(reply)) => reply.outcome,
        _ => None,
    }
}

pub(super) fn begin(binding: &ProofWorkspaceGuardedWriteBinding) -> Operation {
    Operation::ProofWorkspaceGuardedWriteBegin(ProofWorkspaceGuardedWriteBegin {
        binding: Some(binding.clone()),
    })
}

pub(super) fn chunk(binding: &ProofWorkspaceGuardedWriteBinding, lease: &[u8]) -> Operation {
    Operation::ProofWorkspaceGuardedWriteChunk(ProofWorkspaceGuardedWriteChunk {
        binding: Some(binding.clone()),
        lease: lease.to_vec(),
        offset: 0,
        data: BODY.to_vec(),
    })
}

pub(super) fn commit(binding: &ProofWorkspaceGuardedWriteBinding, lease: &[u8]) -> Operation {
    Operation::ProofWorkspaceGuardedWriteCommit(ProofWorkspaceGuardedWriteCommit {
        binding: Some(binding.clone()),
        lease: lease.to_vec(),
    })
}

pub(super) fn begin_lease(
    owner: &mut Owner,
    id: u8,
    binding: &ProofWorkspaceGuardedWriteBinding,
) -> TestResult<Vec<u8>> {
    match stage_outcome(send(owner, id, begin(binding))?) {
        Some(result::Outcome::Begun(lease)) if lease.len() == 40 => Ok(lease),
        _ => Err(io::Error::other("expected guarded staging lease").into()),
    }
}

pub(super) struct LostReply;

impl Write for LostReply {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::from(io::ErrorKind::BrokenPipe))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
