use super::super::*;

fn scope(auth_mode: i32, target: &str) -> ProofTransferScope {
    ProofTransferScope {
        transfer_id: vec![0x11; TRANSFER_ID_BYTES],
        target_id: target.into(),
        target_generation: vec![4],
        auth_mode,
    }
}

#[test]
fn transfer_fixture_grant_refuses_foreign_roles_and_a_replay() {
    let mut grant = TransferGrant::issue(
        "fixture-target",
        &[4],
        TransferVerb::Stream,
        &scope(2, "fixture-target"),
    )
    .expect("native channel grant");
    assert_eq!(grant.target(), ("fixture-target", [4u8].as_slice()));
    assert_eq!(
        grant.authorize_role(GrantRole::Transfer(TransferVerb::Stream)),
        Ok(())
    );
    for role in [GrantRole::Pty, GrantRole::ThreadShell, GrantRole::Peer] {
        assert_eq!(
            grant.authorize_role(role),
            Err(ErrorCode::OperationDenied),
            "{role:?}"
        );
    }
    assert_eq!(
        grant.enter(TransferVerb::PackagedRsync),
        Err(ErrorCode::OperationDenied)
    );
    assert_eq!(grant.enter(TransferVerb::Stream), Ok(()));
    // A grant is single-use; a second entry is never a replay.
    assert_eq!(
        grant.enter(TransferVerb::Stream),
        Err(ErrorCode::OperationDenied)
    );
}

#[test]
fn transfer_fixture_grant_refuses_ordinary_trust_and_stale_scope() {
    for auth_mode in [0, 3, 99] {
        assert_eq!(
            TransferGrant::issue(
                "fixture-target",
                &[4],
                TransferVerb::Stream,
                &scope(auth_mode, "fixture-target")
            )
            .err(),
            Some(ErrorCode::OperationDenied),
            "auth mode {auth_mode}"
        );
    }
    for (target, generation) in [("other-target", &[4][..]), ("fixture-target", &[5][..])] {
        assert_eq!(
            TransferGrant::issue(
                target,
                generation,
                TransferVerb::Stream,
                &scope(2, "fixture-target")
            )
            .err(),
            Some(ErrorCode::InvalidOperands)
        );
    }
    let mut short = scope(2, "fixture-target");
    short.transfer_id.pop();
    assert_eq!(
        TransferGrant::issue("fixture-target", &[4], TransferVerb::Stream, &short).err(),
        Some(ErrorCode::InvalidOperands)
    );
}

#[test]
fn transfer_fixture_launch_escape_hatches_are_refused_field_by_field() {
    let mut attempt = LaunchAttempt::default();
    assert_eq!(validate_launch(&attempt), Ok(()));
    // The wire shape maps one-to-one onto the refusal surface.
    let wire = crate::v1::ProofTransferLaunchAttempt {
        executable: String::new(),
        argv: Vec::new(),
        env: Vec::new(),
        ssh_option: String::new(),
    };
    assert_eq!(LaunchAttempt::from_wire(&wire), attempt);
    attempt.executable = "/bin/sh".into();
    assert_eq!(validate_launch(&attempt), Err(ErrorCode::InvalidOperands));
    assert_eq!(attempt.refused_field(), Some(LaunchField::Executable));
    attempt.executable.clear();
    attempt.argv.push("--rsync-path=/bin/sh".into());
    assert_eq!(validate_launch(&attempt), Err(ErrorCode::InvalidOperands));
    assert_eq!(attempt.refused_field(), Some(LaunchField::Argv));
    attempt.argv.clear();
    attempt.env.push("PATH=/tmp".into());
    assert_eq!(validate_launch(&attempt), Err(ErrorCode::InvalidOperands));
    assert_eq!(attempt.refused_field(), Some(LaunchField::Env));
    attempt.env.clear();
    attempt.ssh_option = "-o ProxyCommand=sh".into();
    assert_eq!(validate_launch(&attempt), Err(ErrorCode::InvalidOperands));
    assert_eq!(attempt.refused_field(), Some(LaunchField::SshOption));
    // Empty-but-present vectors are not an escape hatch.
    attempt.ssh_option.clear();
    attempt.argv = vec![String::new()];
    attempt.env = vec![String::new()];
    assert_eq!(validate_launch(&attempt), Ok(()));
}

#[test]
fn transfer_fixture_operands_are_bounded_and_traversal_free() {
    let operands = |source: &str, destination: &str, max_bytes, max_entries| {
        validate_operands(&ProofTransferOperands {
            source: source.into(),
            destination: destination.into(),
            max_bytes,
            max_entries,
        })
    };
    assert!(operands("fixture/source", "fixture/destination", 4096, 8).is_ok());
    for (source, destination, max_bytes, max_entries) in [
        ("", "dest", 4096, 8),
        ("../source", "dest", 4096, 8),
        ("/etc/passwd", "dest", 4096, 8),
        ("~/source", "dest", 4096, 8),
        ("fixture/*", "dest", 4096, 8),
        ("fixture/source", "dest", 0, 8),
        ("fixture/source", "dest", MAX_TRANSFER_BYTES + 1, 8),
        ("fixture/source", "dest", 4096, 0),
        ("fixture/source", "dest", 4096, MAX_ENTRIES + 1),
    ] {
        assert_eq!(
            operands(source, destination, max_bytes, max_entries).err(),
            Some(ErrorCode::InvalidOperands),
            "{source}"
        );
    }
    let long = "a".repeat(MAX_OPERAND_TEXT + 1);
    assert_eq!(
        operands(&long, "dest", 4096, 8).err(),
        Some(ErrorCode::InvalidOperands)
    );
}
