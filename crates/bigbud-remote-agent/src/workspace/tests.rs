use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

struct TestRoot(std::path::PathBuf);

impl TestRoot {
    fn new() -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("bigbud-agent-test-{suffix}"));
        fs::create_dir_all(&path).unwrap();
        Self(path)
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
