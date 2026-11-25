use std::os::unix::process::ExitStatusExt;
use std::path::Path;

use super::*;
use crate::v1::{ProofDeploymentAction, ProofDeploymentActionKind, ProofDeploymentPinnedFile};

const ROOT: &str = "/tmp/bigbud-picker-linux-step/deployment-graphs";
const REQUEST: &str = "2e789a0b-6e7b-411b-8d34-4107f1c18902";
const INSTALL: &str = "1.2.3-aarch64-unknown-linux-gnu-0011223344556677";

fn digest(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

fn action(kind: ProofDeploymentActionKind) -> ProofDeploymentAction {
    ProofDeploymentAction {
        request_id: REQUEST.into(),
        kind: kind as i32,
        install_name: INSTALL.into(),
        archive_sha256: digest('a'),
        manifest_sha256: digest('b'),
        url: "https://example.invalid/graph.tar.gz".into(),
        max_bytes: 1024,
        contents: b"archive".to_vec(),
        authority_id: "c".repeat(32),
        enable_boot: false,
        node_path: "bin/node".into(),
        entry_path: "app/entry.mjs".into(),
        pins: vec![ProofDeploymentPinnedFile {
            path: "bin/node".into(),
            sha256: digest('d'),
        }],
    }
}

fn build(kind: ProofDeploymentActionKind) -> Result<Request, ErrorCode> {
    command(Path::new(ROOT), &action(kind))
}

#[test]
fn only_data_steps_are_dispatchable() {
    for kind in [
        ProofDeploymentActionKind::Unspecified,
        ProofDeploymentActionKind::Cancel,
        ProofDeploymentActionKind::Reattach,
    ] {
        assert_eq!(build(kind).err(), Some(ErrorCode::InvalidOperands));
    }
}

#[test]
fn archive_upload_is_bounded_and_requires_the_exact_digest() {
    assert!(build(ProofDeploymentActionKind::ArchiveUpload).is_ok());
    let mut oversize = action(ProofDeploymentActionKind::ArchiveUpload);
    oversize.contents = vec![0; MAX_ARCHIVE_BYTES + 1];
    assert_eq!(
        command(Path::new(ROOT), &oversize).err(),
        Some(ErrorCode::InvalidOperands)
    );
    let mut empty = action(ProofDeploymentActionKind::ArchiveUpload);
    empty.contents.clear();
    assert_eq!(
        command(Path::new(ROOT), &empty).err(),
        Some(ErrorCode::InvalidOperands)
    );
    let mut digest = action(ProofDeploymentActionKind::ArchiveUpload);
    digest.archive_sha256 = "A".repeat(64);
    assert_eq!(
        command(Path::new(ROOT), &digest).err(),
        Some(ErrorCode::InvalidOperands)
    );
    let mut forged = action(ProofDeploymentActionKind::ArchiveUpload);
    forged.request_id = "../../escape".into();
    assert_eq!(
        command(Path::new(ROOT), &forged).err(),
        Some(ErrorCode::InvalidOperands)
    );
}

#[test]
fn publish_refuses_graph_escapes_and_empty_pins() {
    assert!(build(ProofDeploymentActionKind::Publish).is_ok());
    for path in ["", "/bin/sh", "../escape", "bin//node", "bin/../node"] {
        let mut escaped = action(ProofDeploymentActionKind::Publish);
        escaped.node_path = path.into();
        assert_eq!(
            command(Path::new(ROOT), &escaped).err(),
            Some(ErrorCode::InvalidOperands),
            "{path}"
        );
    }
    let mut no_pins = action(ProofDeploymentActionKind::Publish);
    no_pins.pins.clear();
    assert_eq!(
        command(Path::new(ROOT), &no_pins).err(),
        Some(ErrorCode::InvalidOperands)
    );
    let mut too_many = action(ProofDeploymentActionKind::Publish);
    too_many.pins = vec![too_many.pins[0].clone(); MAX_PINS + 1];
    assert_eq!(
        command(Path::new(ROOT), &too_many).err(),
        Some(ErrorCode::InvalidOperands)
    );
}

#[test]
fn fetch_admits_only_a_bounded_https_asset() {
    assert!(build(ProofDeploymentActionKind::Fetch).is_ok());
    for url in [
        "http://example.invalid/graph",
        "https://example.invalid/a'b",
        "file:///etc/passwd",
    ] {
        let mut refused = action(ProofDeploymentActionKind::Fetch);
        refused.url = url.into();
        assert_eq!(
            command(Path::new(ROOT), &refused).err(),
            Some(ErrorCode::InvalidOperands),
            "{url}"
        );
    }
    for bytes in [0, MAX_FETCH_BYTES + 1] {
        let mut refused = action(ProofDeploymentActionKind::Fetch);
        refused.max_bytes = bytes;
        assert_eq!(
            command(Path::new(ROOT), &refused).err(),
            Some(ErrorCode::InvalidOperands)
        );
    }
}

#[test]
fn start_binds_one_authority_and_boot_consent() {
    let mut refused = action(ProofDeploymentActionKind::Start);
    refused.authority_id = "../authority".into();
    assert_eq!(
        command(Path::new(ROOT), &refused).err(),
        Some(ErrorCode::InvalidOperands)
    );
    let mut refused = action(ProofDeploymentActionKind::Start);
    refused.node_path = "graph/node".into();
    assert!(command(Path::new(ROOT), &refused).is_ok());
}

#[test]
fn the_fixed_script_receives_only_quoted_validated_operands() {
    let request = build(ProofDeploymentActionKind::ArchiveUpload).expect("archive upload");
    assert!(request.remote.starts_with("/bin/sh -c 'set -eu"));
    assert!(
        request
            .remote
            .contains(&format!(" sh '{ROOT}' '{REQUEST}' "))
    );
    assert!(request.remote.ends_with(
        "'archive-upload' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' '7'"
    ));
    assert_eq!(request.stdin.as_deref(), Some(b"archive".as_slice()));
    assert_eq!(request.marker, b"archive-stored\n");
    assert_eq!(request.max_stdout, MARKER_MAX);

    let publish = build(ProofDeploymentActionKind::Publish).expect("publish");
    assert!(publish.remote.contains("'publish'"));
    assert!(
        publish.remote.ends_with(
            "'bin/node:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'"
        )
    );
    assert!(publish.stdin.is_none());
}

#[test]
fn an_ambiguous_dispatch_is_never_reported_as_an_exit() {
    let output = |code, stdout: &[u8], stderr: &[u8]| process::Output {
        status: std::process::ExitStatus::from_raw(code << 8),
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
        truncated: false,
    };
    let upload = ProofDeploymentActionKind::ArchiveUpload;
    let expected = marker(upload);
    let confirmed = decode(
        output(0, b"archive-stored\n", b""),
        upload,
        expected,
        MARKER_MAX,
    )
    .expect("confirmed");
    assert_eq!(confirmed.code, Some(0));
    assert_eq!(
        confirmed.state,
        ProofDeploymentOperationState::Completed as i32
    );

    let refused = decode(output(65, b"", b""), upload, expected, MARKER_MAX).expect("refusal");
    assert_eq!(refused.state, ProofDeploymentOperationState::Refused as i32);

    // Marker mismatch, truncation and lost transport cannot prove the step did not run.
    assert_eq!(
        decode(output(0, b"", b""), upload, expected, MARKER_MAX).err(),
        Some(ErrorCode::OutcomeUnknown)
    );
    let mut truncated = output(0, b"archive-stored\n", b"");
    truncated.truncated = true;
    assert_eq!(
        decode(truncated, upload, expected, MARKER_MAX).err(),
        Some(ErrorCode::OutcomeUnknown)
    );
    assert_eq!(
        decode(
            output(255, b"", b"ssh: connect refused"),
            upload,
            expected,
            MARKER_MAX
        )
        .err(),
        Some(ErrorCode::OutcomeUnknown)
    );
    // Start is an exec: its ordinary exit is the operation result.
    let start = ProofDeploymentActionKind::Start;
    let started = decode(output(0, b"", b""), start, marker(start), STDOUT_MAX).expect("start");
    assert_eq!(
        started.state,
        ProofDeploymentOperationState::Completed as i32
    );
}

#[test]
fn each_action_keeps_its_own_deadline() {
    assert_eq!(
        deadline(ProofDeploymentActionKind::Fetch),
        Duration::from_secs(300)
    );
    assert_eq!(
        deadline(ProofDeploymentActionKind::Publish),
        Duration::from_secs(120)
    );
    assert_eq!(
        deadline(ProofDeploymentActionKind::Start),
        Duration::from_secs(300)
    );
    for kind in [
        ProofDeploymentActionKind::ArchiveUpload,
        ProofDeploymentActionKind::Reset,
    ] {
        assert_eq!(deadline(kind), Duration::from_secs(60));
    }
}
