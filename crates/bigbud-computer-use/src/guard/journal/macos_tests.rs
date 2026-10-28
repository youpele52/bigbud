#![allow(clippy::unwrap_used)]
use crate::{
    guard::{
        DurableRoot,
        test_support::{TestDirectory, armed},
    },
    native_fs::{acl, storage},
};
use std::{
    ffi::CString,
    fs::{self, File},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{OpenOptionsExt, PermissionsExt, symlink},
        },
    },
};

fn private_file(path: &std::path::Path, bytes: &[u8]) -> File {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file
}
fn root(fixture: &TestDirectory) -> DurableRoot {
    DurableRoot::fixture(&fixture.0, false).unwrap()
}

#[test]
fn lock_replacement_or_unlink_invalidates_journal_and_preserves_replacement() {
    for replace in [false, true] {
        let fixture = TestDirectory::new();
        let lock = root(&fixture).lock().unwrap();
        lock.journal().replace(&armed()).unwrap();
        let before = fs::read(fixture.0.join("safety.v1")).unwrap();
        fs::rename(
            fixture.0.join("controller.lock"),
            fixture.0.join("old.lock"),
        )
        .unwrap();
        if replace {
            private_file(&fixture.0.join("controller.lock"), b"replacement");
        }
        assert!(lock.validate().is_err());
        assert!(lock.journal().read().is_err());
        assert!(lock.journal().replace(&armed()).is_err());
        assert_eq!(fs::read(fixture.0.join("safety.v1")).unwrap(), before);
        if replace {
            assert_eq!(
                fs::read(fixture.0.join("controller.lock")).unwrap(),
                b"replacement"
            );
        }
    }
}

#[test]
fn retained_journal_inode_rejects_replacement_even_with_identical_valid_bytes() {
    let fixture = TestDirectory::new();
    let lock = root(&fixture).lock().unwrap();
    lock.journal().replace(&armed()).unwrap();
    let path = fixture.0.join("safety.v1");
    let bytes = fs::read(&path).unwrap();
    fs::rename(&path, fixture.0.join("old.journal")).unwrap();
    private_file(&path, &bytes);
    assert!(lock.journal().read().is_err());
    assert!(lock.journal().replace(&armed()).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    drop(lock);
    // A fresh election can read valid persistent state, not adopt it as admission.
    assert_eq!(
        root(&fixture).lock().unwrap().journal().read().unwrap(),
        Some(armed())
    );
}

#[test]
fn unexpected_new_journal_is_not_overwritten_or_treated_as_initial() {
    let fixture = TestDirectory::new();
    let lock = root(&fixture).lock().unwrap();
    private_file(&fixture.0.join("safety.v1"), b"unexpected");
    assert!(lock.journal().read().is_err());
    assert!(lock.journal().replace(&armed()).is_err());
    assert_eq!(
        fs::read(fixture.0.join("safety.v1")).unwrap(),
        b"unexpected"
    );
}

#[test]
fn existing_journal_symlink_hardlink_fifo_or_permissive_mode_refuses_election() {
    for kind in ["symlink", "hardlink", "fifo", "mode"] {
        let fixture = TestDirectory::new();
        let path = fixture.0.join("safety.v1");
        private_file(&fixture.0.join("sentinel"), b"untouched");
        match kind {
            "symlink" => symlink(fixture.0.join("sentinel"), &path).unwrap(),
            "hardlink" => fs::hard_link(fixture.0.join("sentinel"), &path).unwrap(),
            "fifo" => {
                let name = CString::new(path.as_os_str().as_bytes()).unwrap();
                // SAFETY: NUL-terminated exclusively owned fixture pathname.
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            }
            _ => {
                private_file(&path, b"bad-mode");
                fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            }
        }
        assert!(root(&fixture).lock().is_err(), "{kind}");
        assert_eq!(fs::read(fixture.0.join("sentinel")).unwrap(), b"untouched");
    }
}

#[test]
fn file_owner_mode_acl_and_link_count_rechecked_after_election() {
    for name in ["controller.lock", "safety.v1"] {
        let fixture = TestDirectory::new();
        let lock = root(&fixture).lock().unwrap();
        lock.journal().replace(&armed()).unwrap();
        let path = fixture.0.join(name);
        let file = File::open(&path).unwrap();
        let component = CString::new(name).unwrap();
        assert!(
            storage::validate(
                lock.root.directory(),
                &component,
                &file,
                lock.root.uid() + 1
            )
            .is_err()
        );
        acl::install_test_acl_text(
            &file,
            c"!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:read\n",
        );
        assert!(lock.journal().read().is_err());
        assert!(lock.journal().replace(&armed()).is_err());
        acl::clear_test_acl(&file);
        assert_eq!(lock.journal().read().unwrap(), Some(armed()));
        fs::hard_link(&path, fixture.0.join("alias")).unwrap();
        assert!(lock.journal().replace(&armed()).is_err());
        fs::remove_file(fixture.0.join("alias")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(lock.journal().read().is_err());
    }
}

#[test]
fn deny_only_journal_acl_is_readable_without_repair_and_storage_fds_are_cloexec() {
    let fixture = TestDirectory::new();
    let lock = root(&fixture).lock().unwrap();
    lock.journal().replace(&armed()).unwrap();
    let file = File::open(fixture.0.join("safety.v1")).unwrap();
    acl::install_test_acl(&file);
    assert_eq!(lock.journal().read().unwrap(), Some(armed()));
    let state = lock.journal_file.lock().unwrap();
    let fd = state.as_ref().unwrap().as_raw_fd();
    // SAFETY: read-only query of a retained fixture journal descriptor.
    assert_ne!(
        unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    acl::clear_test_acl(&file);
}

#[test]
fn serialized_same_process_transactions_survive_fresh_election() {
    let fixture = TestDirectory::new();
    let lock = root(&fixture).lock().unwrap();
    std::thread::scope(|scope| {
        for epoch in 1..=4 {
            let lock = &lock;
            scope.spawn(move || {
                let mut record = armed();
                record.pause_epoch = epoch;
                for _ in 0..4 {
                    lock.journal().replace(&record).unwrap();
                    assert!((1..=4).contains(&lock.journal().read().unwrap().unwrap().pause_epoch));
                }
            });
        }
    });
    let final_record = lock.journal().read().unwrap();
    drop(lock);
    assert_eq!(
        root(&fixture).lock().unwrap().journal().read().unwrap(),
        final_record
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2); // no temp leaks.
}
