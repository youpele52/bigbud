use super::{DurableRoot, RootLayout, account::Account, root::home_components};
use crate::{
    guard::{LockError, test_support::TestDirectory},
    native_fs::{acl, descriptor::open_at},
};
use std::{
    ffi::CString,
    fs::{self, File},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{PermissionsExt, symlink},
        },
    },
    path::Path,
};

fn root_path(base: &Path) -> std::path::PathBuf {
    base.join("Library/Application Support/bigbud/computer-use")
}
fn chmod(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}
fn acl_file(path: &Path) -> File {
    open_at(
        libc::AT_FDCWD,
        &CString::new(path.as_os_str().as_bytes()).unwrap(),
    )
    .unwrap()
}

#[test]
fn account_lookup_reads_only_current_identity_not_environment_storage() {
    let account = Account::current().unwrap(); // passwd metadata only, no home I/O.
    // SAFETY: no arguments and no failure result.
    assert_eq!(account.uid, unsafe { libc::geteuid() });
    assert!(!home_components(&account.home).unwrap().is_empty());
}

#[test]
fn canonical_home_components_refuse_aliases_traversal_relative_and_unbounded_paths() {
    for bad in [
        "",
        "/",
        "relative",
        "/Users/../user",
        "/Users/./user",
        "/Users//user",
        "/Users/user/",
        "/Users/\0user",
    ] {
        assert!(home_components(Path::new(bad)).is_err(), "{bad:?}");
    }
    assert!(home_components(Path::new(&format!("/{}", "x".repeat(4096)))).is_err());
    assert!(home_components(Path::new(&format!("/{}", vec!["x"; 65].join("/")))).is_err());
    assert_eq!(
        home_components(Path::new("/Users/fixture")).unwrap().len(),
        2
    );
}

#[test]
fn creates_fixed_private_suffix_reopens_and_elects_until_owner_drop() {
    let fixture = TestDirectory::new();
    let root = DurableRoot::fixture(&fixture.0, true).unwrap();
    let expected = root_path(&fixture.0);
    assert!(expected.is_dir());
    assert_eq!(
        fs::metadata(&expected).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    root.validate().unwrap();
    let lock = root.lock().unwrap();
    assert!(matches!(
        DurableRoot::fixture(&fixture.0, true).unwrap().lock(),
        Err(LockError::Conflict)
    ));
    // SAFETY: read-only descriptor flag query on the retained fixture root.
    assert_ne!(
        unsafe { libc::fcntl(lock.root.directory().as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    drop(lock);
    DurableRoot::fixture(&fixture.0, true)
        .unwrap()
        .lock()
        .unwrap();
    assert!(expected.join("controller.lock").is_file()); // never delete on Drop.
}

#[test]
fn accepts_normal_deny_delete_acls_without_mutating_existing_ancestors() {
    let fixture = TestDirectory::new();
    fs::create_dir(fixture.0.join("Library")).unwrap();
    chmod(&fixture.0.join("Library"), 0o755);
    acl::install_test_acl(&acl_file(&fixture.0));
    acl::install_test_acl(&acl_file(&fixture.0.join("Library")));
    let root = DurableRoot::fixture(&fixture.0, true).unwrap();
    acl::install_test_acl(root.directory());
    root.validate().unwrap();
    assert_eq!(
        fs::metadata(fixture.0.join("Library"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    // Endpoint policy deliberately remains stricter than durable policy.
    assert!(acl::require_empty(root.directory()).is_err());
    acl::clear_test_acl(root.directory());
    acl::clear_test_acl(&acl_file(&fixture.0.join("Library")));
    acl::clear_test_acl(&acl_file(&fixture.0));
}

#[test]
fn rejects_mutable_ancestor_or_wrong_leaf_mode_without_repair() {
    for (relative, mode) in [
        ("Library", 0o775),
        ("Library/Application Support", 0o777),
        ("Library/Application Support/bigbud/computer-use", 0o755),
    ] {
        let fixture = TestDirectory::new();
        DurableRoot::fixture(&fixture.0, true).unwrap();
        let path = fixture.0.join(relative);
        chmod(&path, mode);
        assert!(DurableRoot::fixture(&fixture.0, true).is_err());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
}

#[test]
fn rejects_symlink_at_each_suffix_without_touching_target() {
    for relative in [
        "Library",
        "Library/Application Support",
        "Library/Application Support/bigbud",
        "Library/Application Support/bigbud/computer-use",
    ] {
        let fixture = TestDirectory::new();
        let outside = TestDirectory::new();
        fs::write(outside.0.join("sentinel"), b"untouched").unwrap();
        let path = fixture.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        symlink(&outside.0, &path).unwrap();
        assert!(DurableRoot::fixture(&fixture.0, true).is_err());
        assert_eq!(fs::read(outside.0.join("sentinel")).unwrap(), b"untouched");
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
    }
}

#[test]
fn observed_root_or_ancestor_replacement_invalidates_owned_election() {
    for relative in ["Library", "Library/Application Support/bigbud/computer-use"] {
        let fixture = TestDirectory::new();
        let root = DurableRoot::fixture(&fixture.0, true).unwrap();
        let lock = root.lock().unwrap();
        let path = fixture.0.join(relative);
        fs::rename(&path, fixture.0.join("old")).unwrap();
        fs::create_dir(&path).unwrap();
        chmod(&path, 0o700);
        assert!(lock.validate().is_err());
        assert!(lock.journal().read().is_err());
        assert_eq!(fs::read_dir(path).unwrap().count(), 0);
    }
}

#[test]
fn actual_acl_mutation_grants_refused_but_read_only_ancestor_grant_accepted() {
    let fixture = TestDirectory::new();
    let root = DurableRoot::fixture(&fixture.0, true).unwrap();
    let ancestor = acl_file(&fixture.0.join("Library"));
    for permission in [
        "write",
        "append",
        "delete_child",
        "delete",
        "writesecurity",
        "chown",
        "writeattr",
        "writeextattr",
    ] {
        let text = CString::new(format!(
            "!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:{permission}\n"
        ))
        .unwrap();
        acl::install_test_acl_text(&ancestor, &text);
        assert!(root.validate().is_err(), "{permission}");
    }
    acl::install_test_acl_text(&ancestor, c"!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:read,readattr,readextattr,readsecurity,execute\n");
    root.validate().unwrap();
    acl::install_test_acl_text(
        root.directory(),
        c"!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:read\n",
    );
    assert!(root.validate().is_err());
    acl::clear_test_acl(root.directory());
    acl::clear_test_acl(&ancestor);
}

#[test]
fn home_walk_rejects_symlink_missing_and_mutable_ancestors_before_creating_suffix() {
    for kind in ["valid", "symlink", "mutable", "missing"] {
        let fixture = TestDirectory::new();
        fs::create_dir(fixture.0.join("Users")).unwrap();
        if kind != "missing" {
            fs::create_dir(fixture.0.join("Users/user")).unwrap();
        }
        if kind == "symlink" {
            fs::rename(fixture.0.join("Users"), fixture.0.join("actual")).unwrap();
            symlink(fixture.0.join("actual"), fixture.0.join("Users")).unwrap();
        }
        if kind == "mutable" {
            chmod(&fixture.0.join("Users"), 0o777);
        }
        let result = DurableRoot::fixture_home(&fixture.0, Path::new("/Users/user"));
        assert_eq!(result.is_ok(), kind == "valid", "{kind}");
        if kind != "valid" {
            assert!(!fixture.0.join("Users/user/Library").exists());
        }
    }
}

#[test]
fn deny_entry_does_not_mask_later_mutating_grant() {
    let fixture = TestDirectory::new();
    let root = DurableRoot::fixture(&fixture.0, true).unwrap();
    let ancestor = acl_file(&fixture.0.join("Library"));
    acl::install_test_acl_text(&ancestor, c"!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:deny:write\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:write\n");
    assert!(root.validate().is_err());
    acl::clear_test_acl(&ancestor);
    root.validate().unwrap();
}

#[test]
fn development_layout_walks_existing_ancestors_and_creates_only_a_private_leaf() {
    let fixture = TestDirectory::new();
    fs::create_dir_all(fixture.0.join("Users/user/.bigbud/dev")).unwrap();
    chmod(&fixture.0.join("Users/user/.bigbud"), 0o755);
    let layout =
        RootLayout::development(Path::new("/Users/user/.bigbud/dev/computer-use")).unwrap();
    let root = DurableRoot::fixture_home_in(&fixture.0, Path::new("/Users/user"), &layout).unwrap();
    let leaf = fixture.0.join("Users/user/.bigbud/dev/computer-use");
    assert_eq!(
        fs::metadata(&leaf).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    // The standard Library root is never created for a development layout.
    assert!(!fixture.0.join("Users/user/Library").exists());
    root.validate().unwrap();
    drop(root);

    // Same checks as the standard layout: a mutable ancestor is refused
    // before anything is created, never repaired.
    let mutable = TestDirectory::new();
    fs::create_dir_all(mutable.0.join("Users/user/.bigbud/dev")).unwrap();
    chmod(&mutable.0.join("Users/user/.bigbud"), 0o777);
    assert!(DurableRoot::fixture_home_in(&mutable.0, Path::new("/Users/user"), &layout).is_err());
    assert!(
        !mutable
            .0
            .join("Users/user/.bigbud/dev/computer-use")
            .exists()
    );

    // A development path outside the account home is refused.
    let outside = RootLayout::development(Path::new("/Users/other/computer-use")).unwrap();
    assert!(DurableRoot::fixture_home_in(&fixture.0, Path::new("/Users/user"), &outside).is_err());
}
