use super::super::tests::Fixture;
use super::*;
use std::fs::{self, File, FileTimes};
use std::os::unix::fs::symlink;
use std::process::Command;
use std::time::{Duration, Instant, UNIX_EPOCH};

fn snapshot_local(
    root: &str,
    relative: &str,
    limit: usize,
) -> Result<v1::ProofWorkspaceSnapshotResult, ErrorCode> {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", &workspace_command(SCRIPT, root, relative)]);
    let output = process::run(command, Instant::now() + DEADLINE, limit)
        .map_err(|_| ErrorCode::WorkspaceReadFailed)?;
    decode(output)
}

fn capture(fixture: &Fixture) -> String {
    snapshot_local(fixture.root(), "", CAPTURE_LIMIT)
        .expect("snapshot of isolated fixture")
        .digest
}

#[test]
fn detects_a_new_file_and_a_same_size_overwrite_within_one_second() {
    let fixture = Fixture::new();
    let empty = capture(&fixture);
    let path = fixture.0.join("-file 'literal *'\t\n");
    let epoch_second = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    let set_mtime = |nanos| {
        File::open(&path)
            .expect("open fixture file")
            .set_times(FileTimes::new().set_modified(epoch_second + Duration::from_nanos(nanos)))
            .expect("set controlled modification time");
        fs::metadata(&path)
            .expect("read fixture metadata")
            .modified()
            .expect("read fixture modification time")
    };
    fs::write(&path, b"old").expect("add file");
    let old_time = set_mtime(123_456_789);
    let added = capture(&fixture);
    assert_ne!(empty, added);
    assert_eq!(added, capture(&fixture));

    fs::write(&path, b"new").expect("overwrite file without changing size");
    let new_time = set_mtime(823_456_789);
    assert!(old_time >= epoch_second && new_time > old_time);
    assert!(new_time < epoch_second + Duration::from_secs(1));
    let overwritten = capture(&fixture);
    assert_ne!(added, overwritten);
    assert_eq!(overwritten.len(), 64);
    assert!(
        overwritten
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    );

    fs::write(&path, b"larger").expect("overwrite file with different size");
    assert_eq!(new_time, set_mtime(823_456_789));
    assert_ne!(overwritten, capture(&fixture));
}

#[test]
fn ignores_symlinks_and_does_not_recurse_into_child_directories() {
    let fixture = Fixture::new();
    let empty = capture(&fixture);
    let child = fixture.0.join(".child");
    fs::create_dir(&child).expect("create immediate child directory");
    let nested = child.join("nested");
    fs::write(&nested, b"old").expect("create nested file");
    let before = capture(&fixture);
    assert_ne!(empty, before);
    fs::write(&nested, b"new size").expect("overwrite nested file");
    symlink(".child", fixture.0.join("linked-dir")).expect("create symlink to directory");
    symlink(".child/nested", fixture.0.join("linked-file")).expect("create symlink to file");
    symlink("absent", fixture.0.join("dangling")).expect("create dangling symlink");
    assert_eq!(before, capture(&fixture));
    assert_eq!(
        snapshot_local(fixture.root(), "linked-dir", CAPTURE_LIMIT),
        Err(ErrorCode::WorkspacePathDenied)
    );
}

#[test]
fn captures_across_stat_batches_and_rejects_truncation_at_record_boundary() {
    let fixture = Fixture::new();
    for index in 0..128 {
        fs::write(fixture.0.join(format!("file-{index:03}")), []).expect("create batch fixture");
    }
    let before = capture(&fixture);
    fs::write(fixture.0.join(".hidden"), []).expect("add hidden file to second batch");
    assert_ne!(before, capture(&fixture));
    assert_eq!(
        snapshot_local(fixture.root(), "", MARKER.len()),
        Err(ErrorCode::WorkspaceReadFailed)
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn cancellable_snapshot_discards_partial_capture_after_child_starts() {
    let fixture = Fixture::new();
    let ready = fixture.0.join("ready");
    let mut held = Command::new("/bin/sh");
    held.args([
        "-c",
        "printf 'BIGBUD_WORKSPACE_SNAPSHOT_V1\\000'; printf '%s\\n' \"$$\" > \"$1\"; exec /bin/sleep 30",
        "snapshot-fixture",
    ])
    .arg(&ready);
    assert_eq!(
        run_cancellable(held, Instant::now() + Duration::from_secs(5), || {
            fs::read_to_string(&ready).is_ok_and(|text| text.ends_with('\n'))
        }),
        Err(ErrorCode::ListCancelled),
    );
    let pid = fs::read_to_string(&ready).expect("started child PID");
    let status = Command::new("/bin/ps")
        .args(["-o", "pid=", "-p", pid.trim()])
        .output()
        .expect("inspect reaped fixture child");
    assert!(status.stdout.is_empty(), "cancelled child was not reaped");

    let mut next = Command::new("/bin/sh");
    next.args(["-c", &workspace_command(SCRIPT, fixture.root(), "")]);
    assert_eq!(
        run_cancellable(next, Instant::now() + DEADLINE, || false)
            .expect("next fixture snapshot succeeds")
            .digest,
        capture(&fixture),
    );
}

#[test]
fn digest_sorts_raw_names_and_rejects_malformed_records() {
    let marked = |payload: &[u8]| [MARKER, payload].concat();
    let directory = &b"d\t96:1700000000.123456789\t.child\0"[..];
    let file = &b"f\t0:1700000000.000000000\todd\t\n\xff\0"[..];
    let first = marked(&[directory, file].concat());
    let second = marked(&[file, directory].concat());
    let digest = parse(&first, false).expect("valid raw filename").digest;
    assert_eq!(
        digest,
        parse(&second, false).expect("reordered records").digest
    );
    assert_eq!(parse(&second, true), Err(ErrorCode::WorkspaceReadFailed));
    assert_eq!(parse(b"", false), Err(ErrorCode::WorkspaceReadFailed));
    for malformed in [
        &b"f\t9:1.0\tnot-complete"[..],
        b"f\t9:1.0\tchild/nested\0",
        b"l\t9:1.0\tlink\0",
        b"f\t9:invalid\tchild\0",
        b"f\t:1.0\tchild\0",
        &[file, file].concat(),
    ] {
        assert_eq!(
            parse(&marked(malformed), false),
            Err(ErrorCode::WorkspaceReadFailed)
        );
    }
}
