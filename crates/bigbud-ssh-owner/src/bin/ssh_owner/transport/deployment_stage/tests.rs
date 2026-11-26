use std::os::unix::process::ExitStatusExt;

use super::*;

const ROOT: &str = "/tmp/bigbud-picker-linux-test123/deployment-graphs";
const INPUT: StageOperands<'_> = StageOperands {
    request_id: "2e789a0b-6e7b-411b-8d34-4107f1c18902",
    install_name: "1.2.3-beta+test-x86_64-unknown-linux-musl-aaaaaaaaaaaaaaaa",
    archive_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    manifest_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

#[test]
fn deployment_stage_accepts_only_disposable_root_paths() {
    assert!(FixtureRoot::new(Path::new(ROOT)).is_ok());
    for invalid in [
        "/tmp",
        "/home/test/.bigbud/backend-graphs",
        "/tmp/bigbud-picker-linux-/deployment-graphs",
        "/tmp/bigbud-picker-linux-test123/home/deployment-graphs",
        "/tmp/bigbud-picker-linux-test/../deployment-graphs",
        "/tmp/bigbud-picker-linux-test/deployment-graphs/",
        "/tmp/bigbud-picker-linux-';x/deployment-graphs",
    ] {
        assert_eq!(
            FixtureRoot::new(Path::new(invalid)).unwrap_err(),
            ErrorCode::ConfigUnsupported
        );
    }
}

#[test]
fn deployment_stage_binds_every_operand_even_when_alternatives_are_valid() {
    let root = FixtureRoot::new(Path::new(ROOT)).expect("fixture root");
    let cmd = command(&root, INPUT, INPUT).expect("approved request");
    assert!(cmd.starts_with("/bin/sh -c 'set -eu\n"));
    assert!(cmd.ends_with(&format!(
        " sh '{ROOT}' '{}' '{}' '{}' '{}'",
        INPUT.request_id, INPUT.install_name, INPUT.archive_sha256, INPUT.manifest_sha256
    )));

    for other in [
        StageOperands {
            request_id: "3e789a0b-6e7b-411b-8d34-4107f1c18902",
            ..INPUT
        },
        StageOperands {
            install_name: "1.2.3-aarch64-unknown-linux-gnu-aaaaaaaaaaaaaaaa",
            ..INPUT
        },
        StageOperands {
            archive_sha256: "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ..INPUT
        },
        StageOperands {
            manifest_sha256: INPUT.archive_sha256,
            ..INPUT
        },
    ] {
        assert!(command(&root, other, other).is_ok());
        assert_eq!(
            command(&root, other, INPUT),
            Err(ErrorCode::OperationDenied)
        );
    }
}

#[test]
fn deployment_stage_refuses_bad_operands_even_if_approved() {
    let root = FixtureRoot::new(Path::new(ROOT)).expect("fixture root");
    for invalid in [
        StageOperands {
            request_id: "2e789a0b-6e7b-511b-8d34-4107f1c18902",
            ..INPUT
        },
        StageOperands {
            request_id: "2e789a0b-6e7b-411b-7d34-4107f1c18902",
            ..INPUT
        },
        StageOperands {
            install_name: "../1.2.3-x86_64-unknown-linux-musl-aaaaaaaaaaaaaaaa",
            ..INPUT
        },
        StageOperands {
            install_name: "1.2.3-riscv-unknown-linux-gnu-aaaaaaaaaaaaaaaa",
            ..INPUT
        },
        StageOperands {
            install_name: "1.2.3-x86_64-unknown-linux-musl-baaaaaaaaaaaaaaa",
            ..INPUT
        },
        StageOperands {
            archive_sha256: "too short",
            ..INPUT
        },
        StageOperands {
            manifest_sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ..INPUT
        },
    ] {
        assert_eq!(
            command(&root, invalid, invalid),
            Err(ErrorCode::InvalidOperands)
        );
    }
}

#[test]
fn deployment_stage_decodes_only_known_bounded_results() {
    let decode_status = |code, stdout: &[u8], stderr: &[u8], truncated| {
        decode(process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
            truncated,
        })
    };
    assert_eq!(
        decode_status(0, b"staged\n", b"", false),
        Ok(BeginResult::Staged)
    );
    assert_eq!(
        decode_status(0, b"present\n", b"", false),
        Ok(BeginResult::Present)
    );
    assert_eq!(
        decode_status(70, b"", b"", false),
        Ok(BeginResult::FixtureUnavailable)
    );
    assert_eq!(
        decode_status(73, b"", b"", false),
        Ok(BeginResult::Conflict)
    );
    for (code, stdout) in [(0, &b"present\n\n"[..]), (0, b""), (73, b"staged\n")] {
        assert_eq!(
            decode_status(code, stdout, b"", false),
            Err(ErrorCode::ListInvalidOutput)
        );
    }
    assert_eq!(
        decode_status(255, b"staged\n", b"", false),
        Err(ErrorCode::TransportLost)
    );
    assert_eq!(
        decode_status(255, b"", b"Host key verification failed", false),
        Err(ErrorCode::HostKeyChanged)
    );
    for (stdout, stderr, truncated) in [
        (&b"staged\n"[..], &b""[..], true),
        (&[b'x'; STDOUT_MAX + 1][..], b"", false),
        (b"staged\n", &[b'x'; STDERR_MAX + 1][..], false),
    ] {
        assert_eq!(
            decode_status(0, stdout, stderr, truncated),
            Err(ErrorCode::ProofDeploymentOutputLimit)
        );
    }
}
