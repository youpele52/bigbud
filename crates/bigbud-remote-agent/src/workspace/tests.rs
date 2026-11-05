use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

struct TestRoot(std::path::PathBuf);

static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);

impl TestRoot {
    fn new() -> Self {
        loop {
            let suffix = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("bigbud-agent-test-{}-{suffix}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed to create test root: {error}"),
            }
        }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn reads_ranges_with_a_hard_bound() {
    let root = TestRoot::new();
    fs::write(root.0.join("file.txt"), "0123456789").unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let result = workspace.read_file("file.txt", 2, 4).unwrap();
    assert_eq!(result.bytes, b"2345");
    assert_eq!(result.total_bytes, 10);
    assert!(result.truncated);
}

#[test]
fn writes_atomically_with_created_parent_directories() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    assert_eq!(
        workspace
            .write_file("nested/file.txt", b"new contents", None)
            .unwrap(),
        12
    );
    assert_eq!(
        fs::read(root.0.join("nested/file.txt")).unwrap(),
        b"new contents"
    );
}

#[cfg(unix)]
#[test]
fn writes_preserve_existing_unix_permission_bits() {
    use sha2::{Digest, Sha256};

    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let expected_sha256 = format!("{:x}", Sha256::digest(b"replacement"));
    for mode in [0o755, 0o751, 0o640, 0o444, 0o2750, 0o4750, 0o1700] {
        let name = format!("file-{mode:o}");
        let path = root.0.join(&name);
        fs::write(&path, b"original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();

        for (bytes, expected) in [
            (b"replacement".as_slice(), None),
            (b"autosaved".as_slice(), Some(expected_sha256.as_str())),
        ] {
            assert_eq!(
                workspace.write_file(&name, bytes, expected).unwrap(),
                bytes.len() as u64
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
                mode
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn writes_create_new_files_with_private_unix_permissions() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    workspace.write_file("new.txt", b"private", None).unwrap();
    assert_eq!(
        fs::metadata(root.0.join("new.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o600
    );
}

#[test]
fn rejects_oversized_and_symlinked_writes() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    assert!(matches!(
        workspace.write_file("large.bin", &vec![0; MAX_WRITE_BYTES + 1], None),
        Err(WorkspaceError::WriteLimitExceeded)
    ));
    #[cfg(unix)]
    {
        let outside = TestRoot::new();
        std::os::unix::fs::symlink(&outside.0, root.0.join("link")).unwrap();
        assert!(matches!(
            workspace.write_file("link/secret.txt", b"secret", None),
            Err(WorkspaceError::SymlinkComponent)
        ));
    }
}

#[test]
fn rejects_stale_expected_hash_without_replacing_file() {
    let root = TestRoot::new();
    fs::write(root.0.join("file.txt"), "current").unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let result = workspace.write_file("file.txt", b"next", Some(&"0".repeat(64)));
    assert!(matches!(result, Err(WorkspaceError::WriteConflict { .. })));
    assert_eq!(
        fs::read_to_string(root.0.join("file.txt")).unwrap(),
        "current"
    );
}

#[test]
fn rejects_lexical_traversal_and_symlink_escape() {
    let root = TestRoot::new();
    fs::write(root.0.join("file.txt"), "safe").unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    assert!(matches!(
        workspace.read_file("../file.txt", 0, 10),
        Err(WorkspaceError::InvalidPath(_))
    ));
    #[cfg(unix)]
    {
        let outside = TestRoot::new();
        fs::write(outside.0.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside.0, root.0.join("link")).unwrap();
        assert!(matches!(
            workspace.read_file("link/secret.txt", 0, 10),
            Err(WorkspaceError::SymlinkComponent)
        ));
    }
}

#[cfg(unix)]
#[test]
fn watch_snapshots_skip_symlinks_without_weakening_directory_listing() {
    let root = TestRoot::new();
    fs::write(root.0.join("AGENTS.md"), "instructions").unwrap();
    std::os::unix::fs::symlink("AGENTS.md", root.0.join("CLAUDE.md")).unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();

    assert!(matches!(
        workspace.list_directory(""),
        Err(WorkspaceError::SymlinkComponent)
    ));

    let watch_workspace = WorkspaceRoot::open(&root.0).unwrap();
    for _ in 0..2 {
        let watch_entries =
            <WorkspaceRoot as bigbud_workspace_watch::WorkspaceWatchHost>::list_directory(
                &watch_workspace,
                "",
            )
            .unwrap();
        assert_eq!(
            watch_entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["AGENTS.md"]
        );
    }
}

#[test]
fn lists_and_searches_without_walking_ignored_directories() {
    let root = TestRoot::new();
    fs::create_dir_all(root.0.join("src")).unwrap();
    fs::create_dir_all(root.0.join("node_modules")).unwrap();
    fs::write(root.0.join("src/main.rs"), "needle here\n").unwrap();
    fs::write(root.0.join("node_modules/hidden.rs"), "needle hidden\n").unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    assert_eq!(
        workspace.search_names(".", "main", 10).unwrap(),
        vec!["src/main.rs"]
    );
    assert_eq!(
        workspace.search_content(".", "needle", 10).unwrap().len(),
        1
    );
    assert_eq!(
        workspace.list_directory("src").unwrap()[0].path,
        "src/main.rs"
    );
}
