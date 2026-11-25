use super::*;
use crate::v1::{
    ProofGuardedWriteConflict, ProofWorkspaceGuardedWriteResult,
    proof_workspace_guarded_write_result::Outcome as ApplyOutcome,
};
use std::{fs, os::unix::fs::PermissionsExt};

const OP: &str = "0123456789abcdef0123456789abcdef";

fn apply(binding: &ProofWorkspaceGuardedWriteBinding, lease: &[u8]) -> Operation {
    Operation::ProofWorkspaceGuardedWriteApply(ProofWorkspaceGuardedWriteApply {
        binding: Some(binding.clone()),
        lease: lease.to_vec(),
    })
}

fn apply_outcome(reply: Reply) -> Option<ApplyOutcome> {
    match reply.outcome {
        Some(Outcome::ProofWorkspaceGuardedWriteResult(result)) => result.outcome,
        _ => None,
    }
}

fn stage(
    owner: &mut Owner,
    id: u8,
    binding: &ProofWorkspaceGuardedWriteBinding,
) -> TestResult<Vec<u8>> {
    let lease = begin_lease(owner, id, binding)?;
    assert_eq!(
        stage_outcome(send(owner, id + 1, chunk(binding, &lease))?),
        binding.body_bytes.map(result::Outcome::ChunkAccepted)
    );
    Ok(lease)
}

#[test]
fn guarded_apply_is_default_denied_and_cannot_be_granted_in_stage_only_mode() -> TestResult {
    let fixture = Fixture::new("applydeny")?;
    let mut owner = fixture.owner()?;
    let binding = fixture.binding(OP);
    let lock = fixture.0.join("owner.lock");
    let mut config = fixture.config();
    assert!(GuardedWrite::for_apply_fixture(&config, &lock, owner.generation).is_none());
    config.ssh = "/usr/bin/ssh".into();
    config.keyscan = "/usr/bin/ssh-keyscan".into();
    assert!(GuardedWrite::for_apply_fixture(&config, &lock, owner.generation).is_some());
    config.alias_config = Some((fixture.0.join("owner-alias.conf"), "fixture".into()));
    assert!(GuardedWrite::for_apply_fixture(&config, &lock, owner.generation).is_none());

    owner.guarded_write = None;
    let denied = request(&owner, 1, apply(&binding, &[0; 40]));
    assert_eq!(
        owner.issue(denied).error,
        i32::from(ErrorCode::OperationDenied)
    );
    fixture.enable(&mut owner);
    let lease = stage(&mut owner, 2, &binding)?;
    let denied = request(&owner, 4, apply(&binding, &lease));
    assert_eq!(
        owner.issue(denied).error,
        i32::from(ErrorCode::OperationDenied)
    );
    assert_eq!(
        stage_outcome(send(&mut owner, 5, commit(&binding, &lease))?),
        Some(result::Outcome::ValidatedNotDispatched(Empty {}))
    );
    assert!(!fixture.0.join("recorder.called").exists());
    Ok(())
}

// Do not require a daemon or Python here. Only this test can combine the
// recorder transport with an APPLY capability; startup rejects that config.
fn recorder_owner(fixture: &Fixture) -> TestResult<Owner> {
    fs::write(
        fixture.0.join("known_hosts"),
        "[127.0.0.1]:22222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
    )?;
    fs::set_permissions(
        fixture.0.join("known_hosts"),
        fs::Permissions::from_mode(0o600),
    )?;
    let mut owner = fixture.owner()?;
    fixture.enable(&mut owner);
    let Some(guarded) = owner.guarded_write.as_mut() else {
        return Err(io::Error::other("expected guarded fixture").into());
    };
    guarded.apply_proof = true;
    Ok(owner)
}

#[test]
fn guarded_apply_binds_its_own_grant_and_finalizes_even_when_reply_is_lost() -> TestResult {
    let fixture = Fixture::new("applylost")?;
    let binding = fixture.binding(OP);
    let recorder = fixture.0.join("recorder");
    // Read stdin to EOF before returning, just as the guarded recipe must.
    fs::write(
        &recorder,
        b"#!/bin/sh\n/bin/cat >> \"$0.called\"\nprintf 'BAD ACK\\n'\n",
    )?;
    let mut owner = recorder_owner(&fixture)?;
    let lease = stage(&mut owner, 1, &binding)?;
    let wrong_verb = grant(&mut owner, 3, commit(&binding, &lease));
    assert_error(
        owner.request(
            &mut Pipe::new(&[][..], Vec::new()),
            Request {
                operation: Some(apply(&binding, &lease)),
                ..wrong_verb
            },
        )?,
        ErrorCode::OperationDenied,
    );
    let mut wrong = binding.clone();
    wrong.relative_path = "other.txt".into();
    assert_error(
        send(&mut owner, 4, apply(&wrong, &lease))?,
        ErrorCode::OperationDenied,
    );
    assert!(!fixture.0.join("recorder.called").exists());

    let accepted = grant(&mut owner, 5, apply(&binding, &lease));
    let input = frames([Payload::Request(accepted.clone())])?;
    assert!(
        owner
            .serve_session(&mut Pipe::new(input.as_slice(), LostReply), |_| Ok(()))
            .is_err()
    );
    assert_eq!(fs::read(fixture.0.join("recorder.called"))?, BODY);
    assert_error(
        send(&mut owner, 6, apply(&binding, &lease))?,
        ErrorCode::OperationDenied,
    );
    owner.park();
    let hydrate = frames([snapshot(1, false)])?;
    owner.rebind(&mut Pipe::new(hydrate.as_slice(), Vec::new()))?;
    assert_error(
        owner.request(&mut Pipe::new(&[][..], Vec::new()), accepted)?,
        ErrorCode::StaleGeneration,
    );
    assert_error(
        send(&mut owner, 7, begin(&binding))?,
        ErrorCode::OperationDenied,
    );
    assert_eq!(fs::read(fixture.0.join("recorder.called"))?, BODY);
    Ok(())
}

#[test]
fn guarded_apply_reports_unknown_after_bad_ack_and_honors_disconnect_fences() -> TestResult {
    let fixture = Fixture::new("applyfence")?;
    let mut owner = recorder_owner(&fixture)?;
    let binding = fixture.binding(OP);
    let lease = stage(&mut owner, 1, &binding)?;
    let accepted = grant(&mut owner, 3, apply(&binding, &lease));
    transition(&mut owner, 4, true, 2)?;
    let denied = request(&owner, 5, apply(&binding, &lease));
    assert_eq!(
        owner.issue(denied).error,
        i32::from(ErrorCode::TargetDisconnected)
    );
    transition(&mut owner, 6, false, 3)?;
    assert_error(
        owner.request(&mut Pipe::new(&[][..], Vec::new()), accepted)?,
        ErrorCode::StaleGeneration,
    );
    assert_error(
        send(&mut owner, 7, apply(&binding, &lease))?,
        ErrorCode::OperationDenied,
    );
    assert!(!fixture.0.join("recorder.called").exists());

    let lease = stage(&mut owner, 8, &binding)?;
    let reply = send(&mut owner, 10, apply(&binding, &lease))?;
    assert_eq!(reply.request_id, [10]);
    assert_eq!(reply.owner_epoch, owner.epoch);
    assert_eq!(reply.target_generation, owner.generation);
    assert_eq!(apply_outcome(reply), Some(ApplyOutcome::Unknown(Empty {})));
    assert!(fixture.0.join("recorder.called").exists());
    assert_error(
        send(&mut owner, 11, begin(&binding))?,
        ErrorCode::OperationDenied,
    );
    Ok(())
}

#[test]
fn guarded_apply_rejects_unverified_data_and_never_launches_for_invalid_recipe_scope() -> TestResult
{
    let fixture = Fixture::new("applyinvalid")?;
    let mut owner = recorder_owner(&fixture)?;
    let mut binding = fixture.binding(OP);
    let attempted = binding.attempted_sha256.clone();
    binding.attempted_sha256 = Sha256::digest(b"not the staged bytes").to_vec();
    let lease = stage(&mut owner, 1, &binding)?;
    assert_error(
        send(&mut owner, 3, apply(&binding, &lease))?,
        ErrorCode::InvalidOperands,
    );
    assert!(!fixture.0.join("recorder.called").exists());

    binding.attempted_sha256 = attempted;
    // Accepted by the generic staging grammar, never by the fixed recipe.
    binding.relative_path = "not a recipe path.txt".into();
    let lease = stage(&mut owner, 4, &binding)?;
    let reply = send(&mut owner, 6, apply(&binding, &lease))?;
    assert_eq!(apply_outcome(reply), Some(ApplyOutcome::Terminal(Empty {})));
    assert_error(
        send(&mut owner, 7, begin(&binding))?,
        ErrorCode::OperationDenied,
    );
    assert!(!fixture.0.join("recorder.called").exists());
    Ok(())
}

fn transition(owner: &mut Owner, id: u8, disconnect: bool, seq: u64) -> TestResult {
    let operation = if disconnect {
        Operation::Disconnect(Empty {})
    } else {
        Operation::Connect(Empty {})
    };
    let request = grant(owner, id, operation);
    let ack = frames([Payload::ProofStorageResult(ProofStorageResult {
        request_id: request.request_id.clone(),
        seq,
        committed: true,
        error: 0,
    })])?;
    let reply = owner.request(&mut Pipe::new(ack.as_slice(), Vec::new()), request)?;
    assert!(matches!(reply.outcome, Some(Outcome::Connection(_))));
    Ok(())
}

#[test]
fn guarded_apply_wire_tags_and_conflict_presence_match_contract() {
    assert_eq!(
        Request {
            operation: Some(apply(&ProofWorkspaceGuardedWriteBinding::default(), &[42])),
            ..Request::default()
        }
        .encode_to_vec(),
        [0xda, 3, 5, 0x0a, 0, 0x12, 1, 42]
    );
    for (outcome, payload) in [
        (
            ApplyOutcome::SavedSha256(vec![0xab; 32]),
            [&[0x0a, 32], [0xab; 32].as_slice()].concat(),
        ),
        (
            ApplyOutcome::Conflict(ProofGuardedWriteConflict {
                current_sha256: None,
            }),
            vec![0x12, 0],
        ),
        (
            ApplyOutcome::Conflict(ProofGuardedWriteConflict {
                current_sha256: Some(vec![0xcd; 32]),
            }),
            [&[0x12, 34, 0x0a, 32], [0xcd; 32].as_slice()].concat(),
        ),
        (ApplyOutcome::Terminal(Empty {}), vec![0x1a, 0]),
        (ApplyOutcome::Unknown(Empty {}), vec![0x22, 0]),
    ] {
        let reply = Reply {
            outcome: Some(Outcome::ProofWorkspaceGuardedWriteResult(
                ProofWorkspaceGuardedWriteResult {
                    outcome: Some(outcome),
                },
            )),
            ..Reply::default()
        };
        let expected = [
            &[0xaa, 2, u8::try_from(payload.len()).unwrap_or_default()],
            payload.as_slice(),
        ]
        .concat();
        assert_eq!(reply.encode_to_vec(), expected);
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires a newly provisioned disposable loopback picker sshd"]
fn live_private_openssh_guarded_apply() -> TestResult {
    use std::{env, mem::ManuallyDrop};

    assert_eq!(
        env::var("BIGBUD_SSH_OWNER_GUARDED_WRITE_APPLY_PROOF").as_deref(),
        Ok("approved-disposable")
    );
    let fixture = ManuallyDrop::new(Fixture(env::var("BIGBUD_GUARDED_RECIPE_ROOT")?.into()));
    let mut config = fixture.config();
    config.ssh = "/usr/bin/ssh".into();
    config.keyscan = "/usr/bin/ssh-keyscan".into();
    config.port = env::var("BIGBUD_GUARDED_RECIPE_PORT")?.parse()?;
    config.user = env::var("BIGBUD_GUARDED_RECIPE_USER")?;
    let mut owner = fixture.owner_with(config)?;
    assert!(
        owner
            .guarded_write
            .as_ref()
            .is_some_and(|guarded| guarded.apply_proof)
    );

    let leaf = fixture.workspace().join("edit.txt");
    let mut binding = fixture.binding(OP);
    let lease = stage(&mut owner, 1, &binding)?;
    let reply = send(&mut owner, 3, apply(&binding, &lease))?;
    assert_eq!(
        apply_outcome(reply),
        Some(ApplyOutcome::Conflict(ProofGuardedWriteConflict {
            current_sha256: None
        }))
    );
    assert!(!leaf.exists());
    fs::write(&leaf, b"base")?;

    binding.operation_id = "a".repeat(32);
    let lease = stage(&mut owner, 4, &binding)?;
    assert_eq!(
        stage_outcome(send(&mut owner, 6, commit(&binding, &lease))?),
        Some(result::Outcome::ValidatedNotDispatched(Empty {}))
    );
    assert_eq!(fs::read(&leaf)?, b"base");
    assert_error(
        send(&mut owner, 7, apply(&binding, &lease))?,
        ErrorCode::OperationDenied,
    );

    binding.operation_id = "b".repeat(32);
    let lease = stage(&mut owner, 8, &binding)?;
    let reply = send(&mut owner, 10, apply(&binding, &lease))?;
    assert_eq!(
        apply_outcome(reply),
        Some(ApplyOutcome::SavedSha256(binding.attempted_sha256.clone()))
    );
    assert_eq!(fs::read(&leaf)?, BODY);
    assert_error(
        send(&mut owner, 11, apply(&binding, &lease))?,
        ErrorCode::OperationDenied,
    );

    binding.operation_id = "c".repeat(32);
    let lease = stage(&mut owner, 12, &binding)?;
    let reply = send(&mut owner, 14, apply(&binding, &lease))?;
    assert_eq!(
        apply_outcome(reply),
        Some(ApplyOutcome::Conflict(ProofGuardedWriteConflict {
            current_sha256: Some(binding.attempted_sha256)
        }))
    );
    assert_eq!(fs::read(&leaf)?, BODY);
    Ok(())
}
