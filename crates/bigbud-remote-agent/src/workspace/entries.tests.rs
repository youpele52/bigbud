use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use super::entries::MAX_DELETE_DEPTH;
use super::*;

struct TestRoot(std::path::PathBuf);

static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);

impl TestRoot {
    fn new() -> Self {
        loop {
            let suffix = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "bigbud-agent-entries-{}-{suffix}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed to create test root: {error}"),
            }
        }
    }

    fn workspace(&self) -> WorkspaceRoot {
        WorkspaceRoot::open(self.0.join("ws")).unwrap()
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> TestRoot {
    let root = TestRoot::new();
    fs::create_dir_all(root.0.join("ws/src/nested")).unwrap();
    fs::write(root.0.join("ws/README.md"), "readme").unwrap();
    fs::write(root.0.join("ws/src/nested/a.txt"), "a").unwrap();
    fs::create_dir(root.0.join("outside")).unwrap();
    fs::write(root.0.join("outside/keep.txt"), "keep").unwrap();
    root
}

#[test]
fn creates_one_folder_inside_an_existing_parent() {
    let root = fixture();
    let workspace = root.workspace();
    workspace.create_directory("src/new-folder").unwrap();
    assert!(root.0.join("ws/src/new-folder").is_dir());
}

#[test]
fn refuses_to_create_an_existing_entry_or_missing_parents() {
    let root = fixture();
    let workspace = root.workspace();
    assert!(matches!(
        workspace.create_directory("README.md"),
        Err(WorkspaceError::AlreadyExists)
    ));
    assert_eq!(
        fs::read_to_string(root.0.join("ws/README.md")).unwrap(),
        "readme"
    );
    assert!(matches!(
        workspace.create_directory("src"),
        Err(WorkspaceError::AlreadyExists)
    ));
    assert!(matches!(
        workspace.create_directory("missing/child"),
        Err(WorkspaceError::NotFound(_))
    ));
    assert!(!root.0.join("ws/missing").exists());
}

#[test]
fn refuses_the_root_and_escaping_paths() {
    let root = fixture();
    let workspace = root.workspace();
    for path in ["", ".", "./"] {
        assert!(matches!(
            workspace.create_directory(path),
            Err(WorkspaceError::RootEntry)
        ));
        assert!(matches!(
            workspace.delete_entry(path, EntryKind::Directory),
            Err(WorkspaceError::RootEntry)
        ));
    }
    for path in ["../outside", "/tmp/x", "src/../../outside", "src\\x"] {
        assert!(matches!(
            workspace.delete_entry(path, EntryKind::Directory),
            Err(WorkspaceError::InvalidPath(_))
        ));
        assert!(matches!(
            workspace.create_directory(path),
            Err(WorkspaceError::InvalidPath(_))
        ));
    }
    assert!(root.0.join("outside/keep.txt").is_file());
    assert!(root.0.join("ws").is_dir());
}

#[test]
fn deletes_files_and_nested_folders() {
    let root = fixture();
    let workspace = root.workspace();
    assert_eq!(
        workspace
            .delete_entry("README.md", EntryKind::File)
            .unwrap(),
        EntryKind::File
    );
    assert!(!root.0.join("ws/README.md").exists());
    assert_eq!(
        workspace.delete_entry("src", EntryKind::Directory).unwrap(),
        EntryKind::Directory
    );
    assert!(!root.0.join("ws/src").exists());
    assert!(matches!(
        workspace.delete_entry("src", EntryKind::Directory),
        Err(WorkspaceError::NotFound(_))
    ));
}

#[test]
fn refuses_a_kind_other_than_the_one_confirmed() {
    let root = fixture();
    let workspace = root.workspace();
    assert!(matches!(
        workspace.delete_entry("src", EntryKind::File),
        Err(WorkspaceError::KindMismatch)
    ));
    assert!(matches!(
        workspace.delete_entry("README.md", EntryKind::Directory),
        Err(WorkspaceError::KindMismatch)
    ));
    assert!(root.0.join("ws/src/nested/a.txt").is_file());
    assert!(root.0.join("ws/README.md").is_file());
    assert!(EntryKind::parse_expected("symlink").is_err());
}

#[test]
fn refuses_trees_beyond_the_bounds_before_removing_anything() {
    let root = fixture();
    let workspace = root.workspace();
    let mut deep = root.0.join("ws/deep");
    for _ in 0..=MAX_DELETE_DEPTH {
        deep.push("d");
    }
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("leaf.txt"), "leaf").unwrap();
    assert!(matches!(
        workspace.delete_entry("deep", EntryKind::Directory),
        Err(WorkspaceError::DeleteLimitExceeded)
    ));
    assert!(deep.join("leaf.txt").is_file());
}

#[cfg(unix)]
#[test]
fn removes_symlinks_as_links_and_never_follows_them() {
    use std::os::unix::fs::symlink;
    let root = fixture();
    let workspace = root.workspace();
    symlink(root.0.join("outside"), root.0.join("ws/link-dir")).unwrap();
    symlink(root.0.join("outside/keep.txt"), root.0.join("ws/link-file")).unwrap();
    symlink(root.0.join("outside"), root.0.join("ws/src/inner-link")).unwrap();

    // The confirmed kind does not matter for a link: the link itself is removed.
    assert_eq!(
        workspace
            .delete_entry("link-dir", EntryKind::Directory)
            .unwrap(),
        EntryKind::Symlink
    );
    assert_eq!(
        workspace
            .delete_entry("link-file", EntryKind::File)
            .unwrap(),
        EntryKind::Symlink
    );
    // A real folder containing a link to outside the root removes the link only.
    workspace.delete_entry("src", EntryKind::Directory).unwrap();
    assert!(!root.0.join("ws/link-dir").exists());
    assert!(!root.0.join("ws/src").exists());
    assert_eq!(
        fs::read_to_string(root.0.join("outside/keep.txt")).unwrap(),
        "keep"
    );
}

#[cfg(unix)]
#[test]
fn refuses_paths_through_a_symlinked_parent() {
    use std::os::unix::fs::symlink;
    let root = fixture();
    let workspace = root.workspace();
    symlink(root.0.join("outside"), root.0.join("ws/escape")).unwrap();
    assert!(matches!(
        workspace.delete_entry("escape/keep.txt", EntryKind::File),
        Err(WorkspaceError::SymlinkComponent)
    ));
    assert!(matches!(
        workspace.create_directory("escape/new"),
        Err(WorkspaceError::SymlinkComponent)
    ));
    assert!(root.0.join("outside/keep.txt").is_file());
    assert!(!root.0.join("outside/new").exists());
}
