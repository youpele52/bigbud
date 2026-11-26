use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;

use super::*;

const ROOT: &str = "/tmp/bigbud-picker-linux-Trusted123/deployment-graphs";
const ID: &str = "2e789a0b-6e7b-411b-8d34-4107f1c18902";
const OTHER_ID: &str = "2e789a0b-6e7b-411b-8d34-4107f1c18903";

fn operands(digest: &str) -> ManifestOperands<'_> {
    ManifestOperands {
        request_id: ID,
        manifest_sha256: digest,
    }
}

#[test]
fn deployment_manifest_command_binds_exact_approval_and_stdin_bytes() {
    let root = Path::new(ROOT);
    let body = b"{\"value\":\"'$(false)\"}\n";
    let digest = format!("{:x}", Sha256::digest(body));
    let approved = operands(&digest);
    let remote = command(root, approved, approved, body).expect("approved manifest");
    assert!(remote.ends_with(&format!(" sh '{ROOT}' '{ID}' '{digest}' '{}'", body.len())));
    assert!(!remote.contains("$(false)"));
    assert_eq!(
        command(root, approved, approved, &body[..body.len() - 1]),
        Err(ErrorCode::InvalidOperands)
    );
    let alternative = ManifestOperands {
        request_id: OTHER_ID,
        ..approved
    };
    assert_eq!(
        command(root, alternative, approved, body),
        Err(ErrorCode::OperationDenied)
    );
    let other_digest = "a".repeat(64);
    assert_eq!(
        command(root, operands(&other_digest), approved, body),
        Err(ErrorCode::OperationDenied)
    );
    let invalid = ManifestOperands {
        request_id: "2e789a0b-6e7b-511b-8d34-4107f1c18902",
        ..approved
    };
    assert_eq!(
        command(root, invalid, invalid, body),
        Err(ErrorCode::InvalidOperands)
    );
    let uppercase = digest.to_uppercase();
    let invalid = operands(&uppercase);
    assert_eq!(
        command(root, invalid, invalid, body),
        Err(ErrorCode::InvalidOperands)
    );
    assert_eq!(
        command(
            Path::new("/tmp/deployment-graphs"),
            approved,
            approved,
            body
        ),
        Err(ErrorCode::ConfigUnsupported)
    );
}

#[test]
fn deployment_manifest_applies_the_byte_limit_even_to_approved_digests() {
    for (size, accepted) in [
        (0, false),
        (1, true),
        (MAX_MANIFEST_BYTES, true),
        (MAX_MANIFEST_BYTES + 1, false),
    ] {
        let contents = vec![b'x'; size];
        let digest = format!("{:x}", Sha256::digest(&contents));
        let approved = operands(&digest);
        let remote = command(Path::new(ROOT), approved, approved, &contents);
        if accepted {
            assert!(
                remote
                    .expect("bounded input")
                    .ends_with(&format!(" '{size}'"))
            );
        } else {
            assert_eq!(remote, Err(ErrorCode::InvalidOperands));
        }
    }
}

#[test]
fn deployment_manifest_requires_an_exact_result_and_does_not_mask_ambiguity() {
    let result = |code, stdout: &[u8], stderr: &[u8], truncated| {
        decode(process::Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: stdout.into(),
            stderr: stderr.into(),
            truncated,
        })
    };
    assert_eq!(result(0, MARKER, b"", false), Ok(PutResult::Stored));
    for (code, expected) in [
        (65, PutResult::InputMismatch),
        (70, PutResult::FixtureUnavailable),
        (73, PutResult::Conflict),
        (74, PutResult::WriteFailed),
    ] {
        assert_eq!(result(code, b"", b"", false), Ok(expected));
        assert_eq!(
            result(code, MARKER, b"", false),
            Err(ErrorCode::OutcomeUnknown)
        );
    }
    for code in [0, 64, 75, 255] {
        assert_eq!(
            result(code, b"", b"", false),
            Err(ErrorCode::OutcomeUnknown)
        );
    }
    assert_eq!(result(0, MARKER, b"", true), Err(ErrorCode::OutcomeUnknown));
    assert_eq!(
        result(0, MARKER, &vec![b'x'; STDERR_MAX], false),
        Err(ErrorCode::OutcomeUnknown)
    );
    assert_eq!(
        result(255, b"", b"Host key verification failed", false),
        Err(ErrorCode::HostKeyChanged)
    );
}
