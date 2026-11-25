use super::super::tests::Fixture;
use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::Command;
use v1::{Frame, Reply, frame::Payload, reply::Outcome};

fn local(root: &str, try_git: bool, capture_limit: usize) -> process::Output {
    // These ambient variables would redirect Git away from the fixture if it
    // inherited them. process::run starts the outer shell with a clean env.
    let script = format!(
        "export GIT_DIR=/dev/null GIT_WORK_TREE=/dev/null GIT_INDEX_FILE=/dev/null; {}",
        command(root, try_git)
    );
    let mut shell = Command::new("/bin/sh");
    shell.args(["-c", &script]);
    process::run(shell, Instant::now() + TIMEOUT, capture_limit)
        .map_err(|_| "local index recipe did not complete")
        .expect("run local index recipe")
}

fn local_paths(root: &str, marker: &[u8]) -> Vec<(String, bool)> {
    let output = local(root, true, WIRE_LIMIT);
    assert!(output.status.success(), "{:?}", output.status);
    assert!(output.stdout.starts_with(marker));
    let result = parse(&output.stdout, output.truncated, ENTRIES_WIRE_LIMIT).expect("valid index");
    assert!(!result.truncated);
    result
        .entries
        .into_iter()
        .map(|entry| (entry.path, entry.directory))
        .collect()
}

fn git(root: &Path, args: &[&str]) {
    assert!(
        Command::new("/usr/bin/git")
            .current_dir(root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args)
            .status()
            .expect("run fixture Git command")
            .success()
    );
}

#[test]
fn git_index_uses_cached_and_nonignored_names_with_ancestors() {
    let fixture = Fixture::new();
    let root = fixture.0.join("repo '$(exit 9)'\n");
    fs::create_dir(&root).unwrap();
    git(
        &root,
        &["init", "-q", "--template=", "--object-format=sha1"],
    );
    fs::create_dir_all(root.join("src/sub")).unwrap();
    fs::create_dir(root.join("dist")).unwrap();
    fs::create_dir(root.join("empty")).unwrap();
    fs::create_dir(root.join("node_modules")).unwrap();
    fs::create_dir_all(root.join(".git/info")).unwrap();
    fs::write(root.join(".git/info/exclude"), b"repo-ignored\n").unwrap();
    fs::write(root.join(".gitignore"), b"*.log\n").unwrap();
    fs::write(root.join("src/sub/tracked.log"), []).unwrap();
    fs::write(root.join("dist/tracked"), []).unwrap();
    git(
        &root,
        &["add", "-f", "--", "src/sub/tracked.log", "dist/tracked"],
    );
    fs::remove_file(root.join("src/sub/tracked.log")).unwrap();
    fs::write(root.join("src/sub/untracked\n雪"), []).unwrap();
    fs::write(root.join("src/sub/untracked.log"), []).unwrap();
    fs::write(root.join("node_modules/ignored"), []).unwrap();
    fs::write(root.join("repo-ignored"), []).unwrap();
    let ambient_excludes = fixture.0.join("ambient-excludes");
    fs::write(&ambient_excludes, b"untracked*\n").unwrap();
    git(
        &root,
        &[
            "config",
            "core.excludesFile",
            ambient_excludes.to_str().unwrap(),
        ],
    );
    let outside = fixture.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("not-in-root"), []).unwrap();
    symlink(outside, root.join("link")).unwrap();
    assert_eq!(
        local_paths(root.to_str().unwrap(), GIT_MARKER),
        [
            (".gitignore".into(), false),
            ("link".into(), false), // The link's name is data, not its target.
            ("src".into(), true),
            ("src/sub".into(), true),
            ("src/sub/tracked.log".into(), false),
            ("src/sub/untracked\n雪".into(), false),
        ]
    );
}

#[test]
fn find_index_prunes_recursively_and_treats_names_as_data() {
    let fixture = Fixture::new();
    let root = fixture.0.join("root '$(exit 9)'\n");
    let name = "-file '$(exit 9)' *\t\n\\unicode-雪";
    for dir in ["empty", "src/sub", "dist", "src/.cache", ".hidden-dir"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    for file in [
        name,
        "src/sub/one",
        "dist/pruned",
        "src/.cache/pruned",
        ".hidden",
    ] {
        fs::write(root.join(file), []).unwrap();
    }
    symlink("src", root.join("link")).unwrap();
    symlink("missing", root.join("dangling")).unwrap();
    symlink("src", root.join(".git")).unwrap();
    assert_eq!(
        local_paths(root.to_str().unwrap(), FIND_MARKER),
        [
            (name.into(), false),
            (".hidden".into(), false),
            (".hidden-dir".into(), true),
            ("empty".into(), true),
            ("src".into(), true),
            ("src/sub".into(), true),
            ("src/sub/one".into(), false),
        ]
    );
}

#[test]
fn index_binds_the_exact_root_and_denies_symlink_roots_and_ancestors() {
    let fixture = Fixture::new();
    let root = fixture.0.join("workspace");
    fs::create_dir(&root).unwrap();
    symlink(&root, fixture.0.join("linked-root")).unwrap();
    symlink(&fixture.0, fixture.0.join("linked-parent")).unwrap();
    let requested = root.to_str().unwrap();
    assert_eq!(
        validate_path(Some(&root), requested, "", true),
        Ok(requested)
    );
    assert_eq!(
        validate_path(Some(&root), fixture.root(), "", true),
        Err(ErrorCode::WorkspacePathDenied)
    );
    for root in [
        fixture.0.join("linked-root"),
        fixture.0.join("linked-parent/workspace"),
    ] {
        let output = local(root.to_str().unwrap(), true, WIRE_LIMIT);
        assert_eq!(output.status.code(), Some(3));
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn index_does_not_let_git_probe_linked_nested_metadata() {
    let fixture = Fixture::new();
    let root = fixture.0.join("workspace");
    let outside = fixture.0.join("outside");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::create_dir(&outside).unwrap();
    git(&root, &["init", "-q", "--template="]);
    git(&outside, &["init", "-q", "--template="]);
    symlink(outside.join(".git"), root.join("nested/.git")).unwrap();
    fs::write(root.join("nested/visible"), []).unwrap();
    assert_eq!(
        local_paths(root.to_str().unwrap(), FIND_MARKER),
        [("nested".into(), true), ("nested/visible".into(), false)]
    );
}

#[test]
fn failed_git_output_does_not_mix_with_find() {
    let fixture = Fixture::new();
    git(
        &fixture.0,
        &["init", "-q", "--template=", "--object-format=sha1"],
    );
    fs::write(fixture.0.join(".git/index"), b"not a Git index").unwrap();
    fs::write(fixture.0.join("visible"), []).unwrap();
    let git = local(fixture.root(), true, WIRE_LIMIT);
    assert_eq!(git.status.code(), Some(5));
    assert!(git.stdout.starts_with(GIT_MARKER));
    let find = local(fixture.root(), false, WIRE_LIMIT);
    assert!(find.status.success());
    assert_eq!(find.stdout, [FIND_MARKER, b"f\t./visible\0"].concat());
}

#[test]
fn parser_keeps_complete_records_and_rejects_malformed_paths() {
    let data = [GIT_MARKER, b"a/b\0a/b\0a/partial\xc3"].concat();
    assert_eq!(
        parse(&data, false, ENTRIES_WIRE_LIMIT),
        Err(ErrorCode::WorkspaceReadFailed)
    );
    let parsed = parse(&data, true, ENTRIES_WIRE_LIMIT).unwrap();
    assert!(parsed.truncated);
    assert_eq!(parsed.entries, [entry("a", true), entry("a/b", false)]);
    for path in [
        &b"/absolute\0"[..],
        b"../escape\0",
        b"sub/../escape\0",
        b"a//b\0",
        b"a/./b\0",
        b"\xff\0",
        b"\0",
    ] {
        assert_eq!(
            parse(&[GIT_MARKER, path].concat(), true, ENTRIES_WIRE_LIMIT),
            Err(ErrorCode::WorkspaceReadFailed)
        );
    }
}

fn entry(path: &str, directory: bool) -> ProofWorkspaceIndexedEntry {
    ProofWorkspaceIndexedEntry {
        path: path.into(),
        directory,
    }
}

#[test]
fn exact_wire_budget_leaves_room_for_the_enclosing_frame() {
    let mut bytes = GIT_MARKER.to_vec();
    // A deep prefix adds ancestors and protobuf overhead not in the SSH data.
    for i in 0..5_000 {
        bytes.extend_from_slice(
            format!("{}/file-{i}\0", "a/".repeat(500).trim_end_matches('/')).as_bytes(),
        );
    }
    let index = parse(&bytes, false, ENTRIES_WIRE_LIMIT).unwrap();
    // Use a second set of records large enough to reach the actual byte ceiling.
    assert!(!index.truncated);
    for i in 5_000..10_000 {
        bytes.extend_from_slice(
            format!("{}/file-{i}\0", "a/".repeat(500).trim_end_matches('/')).as_bytes(),
        );
    }
    let index = parse(&bytes, false, ENTRIES_WIRE_LIMIT).unwrap();
    assert!(index.truncated);
    let frame = Frame {
        payload: Some(Payload::Reply(Reply {
            request_id: vec![0; 128],
            owner_epoch: vec![0; 32],
            target_generation: vec![0; 32],
            outcome: Some(Outcome::ProofWorkspaceIndex(index)),
        })),
    };
    assert!(frame.encoded_len() <= WIRE_LIMIT);
    assert!(frame.encoded_len() > WIRE_LIMIT - 2_000);
}

#[test]
fn entry_cap_counts_unique_files_and_ancestors() {
    let mut bytes = GIT_MARKER.to_vec();
    for i in 0..MAX_ENTRIES - 1 {
        let name = format!("sub/{i}\0");
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(name.as_bytes());
    }
    let exact = parse(&bytes, false, ENTRIES_WIRE_LIMIT).unwrap();
    assert_eq!(exact.entries.len(), MAX_ENTRIES);
    assert!(!exact.truncated);
    bytes.extend_from_slice(b"sub/overflow\0");
    let overflow = parse(&bytes, false, ENTRIES_WIRE_LIMIT).unwrap();
    assert_eq!(overflow.entries, exact.entries);
    assert!(overflow.truncated);
}
