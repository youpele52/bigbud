use std::fs::{self, DirBuilder};
use std::net::Ipv4Addr;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

use crate::transport::TransportConfig;

use super::*;

const ROOT: &str = "/private/approved/a'b";
const HOST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn frame(root: &str, generation: u64, record: &str) -> Vec<u8> {
    let digest = format!("{:x}", Sha256::digest(root));
    format!("{MARKER} {HOST} 1001 {digest} {generation}\n{root}\n{record}").into_bytes()
}

fn canonical(root: &str, generation: u64) -> String {
    let digest = format!("{:x}", Sha256::digest(root));
    format!(
        r#"{{"format":"bigbud.workspace-mode.v1","generation":{generation},"hostIdentity":"machine-v1:{HOST}","accountUid":1001,"realpathSha256":"{digest}","mode":"remote-runtime","owner":null}}"#
    )
}

fn output(code: u8, stdout: Vec<u8>) -> process::Output {
    process::Output {
        status: ExitStatus::from_raw(i32::from(code) << 8),
        stdout,
        stderr: vec![],
        truncated: false,
    }
}

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn transport_refuses_root_mismatch_and_missing_pin_before_ssh_launch() {
    let tmp = Path::new("/tmp").canonicalize().expect("temporary parent");
    let path = tmp.join(format!("bb-mode-inspect-{}", std::process::id()));
    DirBuilder::new()
        .mode(0o700)
        .create(&path)
        .expect("private fixture");
    let f = Fixture(path);
    let identity = crate::transport::write_identity_fixture(&f.0);
    let transport = Transport::new(TransportConfig {
        ssh: f.0.join("must-not-spawn"),
        keyscan: f.0.join("must-not-scan"),
        host: Ipv4Addr::LOCALHOST.into(),
        port: 2200,
        user: "fixture".into(),
        identity,
        known_hosts: f.0.join("known_hosts"),
        alias_config: None,
        system_config: None,
        workspace_root: Some(PathBuf::from(ROOT)),
        dev_interactive_terminal: false,
    })
    .expect("valid fixture transport");
    assert!(matches!(
        transport.inspect_workspace_mode("/wrong"),
        Err(ErrorCode::WorkspacePathDenied)
    ));
    assert!(matches!(
        transport.inspect_workspace_mode(ROOT),
        Err(ErrorCode::TrustRequired)
    ));
}

#[test]
fn approves_only_the_exact_root_and_quotes_it_as_one_operand() {
    let remote = command(Some(ROOT), ROOT).expect("fixed command");
    assert!(remote.starts_with("/bin/sh -c '"));
    assert!(remote.ends_with(" sh '/private/approved/a'\\''b'"));
    for root in ["/private/approved", "/private/approved/a'b/.", "/other"] {
        assert!(matches!(
            command(Some(ROOT), root),
            Err(ErrorCode::WorkspacePathDenied)
        ));
    }
    for root in [
        "relative",
        "/a\n/b",
        "/a\x7f",
        &format!("/{}", "a".repeat(ROOT_MAX)),
    ] {
        assert!(command(Some(root), root).is_err());
    }
    assert!(command(None, ROOT).is_err());
}

#[test]
fn accepts_only_the_unchanged_canonical_matching_record() {
    let raw = canonical(ROOT, 4);
    let parsed = parse(&frame(ROOT, 4, &raw)).expect("canonical workspace record");
    assert!(matches!(
        parsed,
        Inspection::Ready { physical_root, host_identity, account_uid: 1001, generation: 4,
            current_record: Some(current), .. }
        if physical_root == ROOT && host_identity == format!("machine-v1:{HOST}") && current == raw
    ));
    assert!(matches!(
        parse(&frame(ROOT, 0, "")),
        Ok(Inspection::Ready {
            current_record: None,
            generation: 0,
            ..
        })
    ));
    for frame in [
        frame(ROOT, 4, ""),
        frame(ROOT, 0, &raw),
        frame("/elsewhere", 4, &raw),
        frame(ROOT, 3, &raw),
        frame(
            ROOT,
            MAX_GENERATION + 1,
            &canonical(ROOT, MAX_GENERATION + 1),
        ),
        frame(ROOT, 4, &format!("{raw}\n")),
        frame(
            ROOT,
            4,
            &raw.replace("\"accountUid\":1001", "\"accountUid\":1"),
        ),
        frame(
            ROOT,
            4,
            &raw.replace("\"owner\":null", "\"owner\":\"invalid\""),
        ),
        frame(ROOT, 4, &"x".repeat(RECORD_MAX + 1)),
    ] {
        assert!(parse(&frame).is_err());
    }
}

#[test]
fn decodes_only_complete_bounded_replies_and_distinguishes_read_races() {
    for (code, expected) in [
        (10, Inspection::NotLinux),
        (11, Inspection::NoMachineId),
        (12, Inspection::MissingFolder),
        (13, Inspection::UnsafeStorage),
    ] {
        assert_eq!(
            decode(output(code, vec![])).expect("verdict"),
            Some(expected)
        );
        assert!(decode(output(code, b"unexpected".to_vec())).is_err());
    }
    assert!(decode(output(14, vec![])).expect("retry").is_none());
    assert!(decode(output(1, frame(ROOT, 0, ""))).is_err());
    assert!(
        decode(process::Output {
            truncated: true,
            ..output(0, frame(ROOT, 0, ""))
        })
        .is_err()
    );
    assert!(
        decode(process::Output {
            stderr: vec![0; STDERR_MAX],
            ..output(0, frame(ROOT, 0, ""))
        })
        .is_err()
    );
}
