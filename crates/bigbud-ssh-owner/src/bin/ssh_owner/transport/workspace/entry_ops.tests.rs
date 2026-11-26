use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::process::Command;

fn fixture() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "bigbud-ssh-entry-ops-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&path).unwrap();
    path.canonicalize().unwrap()
}

fn local(command: &str, input: &[u8]) -> process::Output {
    let mut shell = Command::new("/bin/sh");
    shell.args(["-c", command]);
    process::run_with_input(shell, Instant::now() + TIMEOUT, ACK_LIMIT, input)
        .unwrap_or_else(|_| panic!("local recipe failed"))
}

fn info(root: &str, relative: &str) -> Result<v1::WorkspaceEntryInfo, ErrorCode> {
    decode_info(local(&remote(INFO_SCRIPT, root, relative, ""), b""))
}

fn rename(root: &str, from: &str, to: &str) -> Result<v1::WorkspaceEntryChange, ErrorCode> {
    rename_mode(root, from, to, "")
}

fn rename_mode(
    root: &str,
    from: &str,
    to: &str,
    mode: &str,
) -> Result<v1::WorkspaceEntryChange, ErrorCode> {
    let script = format!("{RENAME_SCRIPT}{PATH_WALK}{RENAME_TAIL}");
    decode_change(local(&remote_with_mode(&script, root, from, to, mode), b""))
}

fn append(root: &str, relative: &str, data: &[u8]) -> Result<v1::WorkspaceEntryChange, ErrorCode> {
    let size = data.len().to_string();
    decode_change(local(&remote(APPEND_SCRIPT, root, relative, &size), data))
}

#[test]
fn info_rename_and_append_stay_inside_the_root_without_following_symlinks() {
    let dir = fixture();
    let root = dir.to_str().unwrap();
    fs::write(dir.join("a.txt"), b"one").unwrap();
    fs::create_dir(dir.join("sub")).unwrap();

    let file = info(root, "a.txt").unwrap();
    assert_eq!((file.kind, file.size), (2, 3));
    assert!(file.mtime_ms > 0);
    assert_eq!(info(root, "sub").unwrap().kind, 3);
    assert_eq!(info(root, "").unwrap().kind, 3);
    assert_eq!(info(root, "missing").unwrap().kind, 1);

    assert_eq!(append(root, "a.txt", b" two").unwrap().result, 1);
    assert_eq!(fs::read(dir.join("a.txt")).unwrap(), b"one two");
    assert_eq!(append(root, "sub", b"x").unwrap().result, 4);
    assert_eq!(append(root, "nope", b"x").unwrap().result, 2);

    assert_eq!(rename(root, "a.txt", "sub/b.txt").unwrap().result, 1);
    assert!(dir.join("sub/b.txt").exists() && !dir.join("a.txt").exists());
    assert_eq!(rename(root, "a.txt", "c.txt").unwrap().result, 2);
    fs::write(dir.join("c.txt"), b"keep").unwrap();
    assert_eq!(rename(root, "sub/b.txt", "c.txt").unwrap().result, 3);
    assert_eq!(fs::read(dir.join("c.txt")).unwrap(), b"keep");

    let outside = dir.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"s").unwrap();
    symlink(&outside, dir.join("link")).unwrap();
    assert_eq!(
        info(root, "link").unwrap_err(),
        ErrorCode::WorkspacePathDenied
    );
    assert_eq!(
        append(root, "link/secret", b"x").unwrap_err(),
        ErrorCode::WorkspacePathDenied
    );
    assert_eq!(
        rename(root, "c.txt", "link/stolen").unwrap_err(),
        ErrorCode::WorkspacePathDenied
    );
    assert_eq!(fs::read(outside.join("secret")).unwrap(), b"s");
    assert!(dir.join("c.txt").exists());
    // A short stdin never appends.
    let size = "10".to_string();
    let short = decode_change(local(&remote(APPEND_SCRIPT, root, "c.txt", &size), b"abc"));
    assert_eq!(short.unwrap_err(), ErrorCode::OutcomeUnknown);
    assert_eq!(fs::read(dir.join("c.txt")).unwrap(), b"keep");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn replace_swaps_a_regular_file_atomically_and_refuses_a_directory() {
    use std::os::unix::fs::MetadataExt;
    let dir = fixture();
    let root = dir.to_str().unwrap();
    fs::write(dir.join("new"), b"new").unwrap();
    fs::write(dir.join("old"), b"old").unwrap();
    let source_inode = fs::metadata(dir.join("new")).unwrap().ino();
    // Without replace the existing destination is kept.
    assert_eq!(rename(root, "new", "old").unwrap().result, 3);
    assert_eq!(
        rename_mode(root, "new", "old", "replace").unwrap().result,
        1
    );
    // rename(2): the destination is now the source's own inode, not a copy.
    assert_eq!(fs::metadata(dir.join("old")).unwrap().ino(), source_inode);
    assert_eq!(fs::read(dir.join("old")).unwrap(), b"new");
    assert!(!dir.join("new").exists());
    fs::create_dir(dir.join("d")).unwrap();
    assert_eq!(rename_mode(root, "old", "d", "replace").unwrap().result, 3);
    assert!(dir.join("old").exists() && dir.join("d").is_dir());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn acknowledgements_require_the_exact_marker() {
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;
    let output = |status, stdout: &[u8]| process::Output {
        status: ExitStatus::from_raw(status << 8),
        stdout: stdout.into(),
        stderr: vec![],
        truncated: false,
    };
    for bad in [
        output(0, b""),
        output(1, b"BIGBUD_WORKSPACE_CHANGE_V1 1\n"),
        output(0, b"BIGBUD_WORKSPACE_CHANGE_V1 9\n"),
        output(0, b"BIGBUD_WORKSPACE_CHANGE_V1 1"),
    ] {
        assert_eq!(decode_change(bad).unwrap_err(), ErrorCode::OutcomeUnknown);
    }
    assert_eq!(
        decode_info(output(0, b"BIGBUD_WORKSPACE_INFO_V1 5 0 0 0\n")).unwrap_err(),
        ErrorCode::WorkspaceReadFailed
    );
}
