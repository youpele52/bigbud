use super::*;
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;

const ROOT: &str = "/private/approved/a'b";
const HOST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn frame(root: &str, generation: u64, record: &str) -> Vec<u8> {
    let digest = format!("{:x}", Sha256::digest(root));
    format!(
        "{} {HOST} 1001 {digest} {generation}\n{root}\n{record}",
        super::super::MARKER
    )
    .into_bytes()
}

fn output(code: u8, stdout: Vec<u8>) -> process::Output {
    process::Output {
        status: ExitStatus::from_raw(i32::from(code) << 8),
        stdout,
        stderr: vec![],
        truncated: false,
    }
}

fn unclaimed(generation: u64) -> String {
    let digest = format!("{:x}", Sha256::digest(ROOT));
    format!(
        r#"{{"format":"bigbud.workspace-mode.v1","generation":{generation},"hostIdentity":"machine-v1:{HOST}","accountUid":1001,"realpathSha256":"{digest}","mode":"laptop-runtime","owner":null}}"#
    )
}

fn remote_mode(generation: u64) -> String {
    unclaimed(generation).replace("laptop-runtime", "remote-runtime")
}

fn claim(generation: u64) -> String {
    unclaimed(generation).replace("null", &format!("\"backend-v1:{OWNER}\""))
}

fn observation(generation: u64, record: &str) -> Inspection {
    parse(&frame(ROOT, generation, record)).expect("valid fixture observation")
}

#[test]
fn native_accepts_only_exact_root_and_canonical_next_laptop_claim() {
    let first = observation(0, "");
    let raw = claim(1);
    let remote = command(Some(ROOT), ROOT, &first, &raw).expect("fixed publish recipe");
    assert!(remote.contains("'/private/approved/a'\\''b'"));
    assert!(remote.ends_with(&format!("'0' '' '{raw}'")));
    assert!(matches!(
        command(Some(ROOT), "/wrong", &first, &raw),
        Err(ErrorCode::WorkspacePathDenied)
    ));
    for next in [
        claim(2),
        remote_mode(1),
        unclaimed(1),
        format!("{raw}\n"),
        raw.replace("laptop-runtime", "remote-runtime"),
        raw.replace(HOST, OWNER),
        raw.replace("1001", "1002"),
    ] {
        assert!(matches!(
            command(Some(ROOT), ROOT, &first, &next),
            Err(ErrorCode::InvalidOperands)
        ));
    }
    assert!(command(Some(ROOT), ROOT, &observation(1, &unclaimed(1)), &claim(2)).is_ok());
    for old in [remote_mode(1), claim(1)] {
        assert!(command(Some(ROOT), ROOT, &observation(1, &old), &claim(2)).is_err());
    }
    assert!(
        command(
            Some(ROOT),
            ROOT,
            &observation(MAX_GENERATION, &unclaimed(MAX_GENERATION)),
            &claim(MAX_GENERATION + 1),
        )
        .is_err()
    );
}

#[test]
fn replies_confirm_only_the_durable_receipt_or_a_valid_newer_generation() {
    use Publication::*;
    let observed = observation(1, &unclaimed(1));
    let receipt = b"bigbud.workspace-mode.publish.v1 committed\n";
    let compare = |actual: Vec<u8>| [COMPARE, actual.as_slice(), COMPARE_END].concat();
    for (code, bytes, expected) in [
        (0, receipt.to_vec(), Committed),
        (0, receipt[..receipt.len() - 1].to_vec(), Uncertain),
        (1, receipt.to_vec(), Uncertain),
        (255, vec![], Uncertain),
        (0, [COMPARE, &frame(ROOT, 2, &claim(2))].concat(), Uncertain),
        (0, compare(frame(ROOT, 2, &claim(2))), Conflict),
        (0, compare(frame(ROOT, 2, "invalid")), UnsafeStorage),
        (0, compare(frame(ROOT, 1, &claim(1))), UnsafeStorage),
        (0, compare(frame(ROOT, 0, "")), UnsafeStorage),
        (0, compare(frame("/elsewhere", 0, "")), ScopeChanged),
        (0, b"conflict\n".to_vec(), Uncertain),
        (
            0,
            b"bigbud.workspace-mode.publish.v1 missing-folder\n".to_vec(),
            MissingFolder,
        ),
    ] {
        assert_eq!(decode(output(code, bytes), &observed), expected);
    }
    assert_eq!(
        decode(
            process::Output {
                truncated: true,
                ..output(0, receipt.to_vec())
            },
            &observed
        ),
        Uncertain
    );
    assert_eq!(
        decode(
            process::Output {
                stderr: vec![0; STDERR_MAX],
                ..output(0, receipt.to_vec())
            },
            &observed
        ),
        Uncertain
    );
}
