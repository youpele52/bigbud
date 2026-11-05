use super::super::macho_tests::thin_bytes;
use super::*;
use crate::{guard::test_support::TestDirectory, native_fs::acl};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

fn chmod(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}
fn setup() -> TestDirectory {
    let base = TestDirectory::new();
    fs::create_dir(base.0.join("generation")).unwrap();
    chmod(&base.0.join("generation"), 0o755);
    fs::write(base.0.join("generation/helper"), thin_bytes()).unwrap();
    chmod(&base.0.join("generation/helper"), 0o555);
    base
}
fn inspect(base: &TestDirectory) -> io::Result<ImagePreflight> {
    ImagePreflight::fixture(&base.0, "generation/helper")
}

#[test]
fn retains_read_only_descriptors_and_revalidates_without_launch_authority() {
    let base = setup();
    let image = inspect(&base).unwrap();
    image.validate().unwrap();
    assert_eq!(image.nodes.len(), 2);
    assert!(crate::owner::private_bootstrap::BootstrapPermit::verify().is_err());
    // Production path cannot bypass the mutable /private/tmp ancestor policy.
    assert!(ImagePreflight::inspect_candidate(&base.0.join("generation/helper")).is_err());
    for node in std::iter::once(&image.anchor).chain(&image.nodes) {
        // SAFETY: read-only queries of fixture-owned retained descriptors.
        let access = unsafe { libc::fcntl(node.file.as_raw_fd(), libc::F_GETFL) };
        assert_eq!(access & libc::O_ACCMODE, libc::O_RDONLY);
        // SAFETY: same live descriptor, flag query only.
        assert_ne!(
            unsafe { libc::fcntl(node.file.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }
}

#[test]
fn rejects_unsafe_path_modes_links_and_nonregular_candidates_without_repair() {
    for mode in [0o644, 0o4555, 0o2775, 0o777, 0o575] {
        let base = setup();
        let path = base.0.join("generation/helper");
        chmod(&path, mode);
        assert!(inspect(&base).is_err(), "{mode:o}");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            mode
        );
    }
    for bad in [
        "relative", "/", "/a/../b", "/a//b", "/a/./b", "/a/", "/a\0b",
    ] {
        assert!(ImagePreflight::inspect_candidate(Path::new(bad)).is_err());
    }
    let base = setup();
    fs::hard_link(base.0.join("generation/helper"), base.0.join("alias")).unwrap();
    assert!(inspect(&base).is_err());
    fs::remove_file(base.0.join("alias")).unwrap();
    fs::rename(base.0.join("generation/helper"), base.0.join("original")).unwrap();
    symlink(base.0.join("original"), base.0.join("generation/helper")).unwrap();
    assert!(inspect(&base).is_err());
    fs::remove_file(base.0.join("generation/helper")).unwrap();
    fs::create_dir(base.0.join("generation/helper")).unwrap();
    assert!(inspect(&base).is_err());
}

#[test]
fn refuses_mutable_ancestor_and_actual_owner_mismatch() {
    let base = setup();
    inspect(&base).unwrap();
    chmod(&base.0.join("generation"), 0o775);
    assert!(inspect(&base).is_err());
    chmod(&base.0.join("generation"), 0o755);
    let image = inspect(&base).unwrap();
    let leaf = image.nodes.last().unwrap();
    Snapshot::read(&leaf.file, image.uid, true).unwrap();
    assert!(Snapshot::read(&leaf.file, image.uid + 1, true).is_err());
}

#[test]
fn acl_grants_are_checked_independently_of_mode_bits() {
    let base = setup();
    let image = inspect(&base).unwrap();
    let leaf = image.nodes.last().unwrap();
    acl::install_test_acl(&leaf.file); // deny-only compatibility, not identity.
    Snapshot::read(&leaf.file, image.uid, true).unwrap();
    acl::install_test_acl_text(
        &leaf.file,
        c"!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:write\n",
    );
    assert_eq!(
        fs::metadata(base.0.join("generation/helper"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o555
    );
    assert!(Snapshot::read(&leaf.file, image.uid, true).is_err());
    acl::clear_test_acl(&leaf.file);
}

#[test]
fn observed_replacement_truncation_and_metadata_change_refuse() {
    for change in 0..5 {
        let base = setup();
        let image = inspect(&base).unwrap();
        image.validate().unwrap();
        let path = base.0.join("generation/helper");
        match change {
            0 => {
                // identical bytes, different inode
                fs::write(base.0.join("replacement"), thin_bytes()).unwrap();
                chmod(&base.0.join("replacement"), 0o555);
                fs::rename(base.0.join("replacement"), &path).unwrap();
            }
            1 => {
                chmod(&path, 0o755);
                fs::write(&path, [0xcf]).unwrap();
            }
            2 => {
                chmod(&path, 0o755);
            }
            3 => {
                fs::rename(base.0.join("generation"), base.0.join("old")).unwrap();
                fs::create_dir(base.0.join("generation")).unwrap();
            }
            _ => {
                fs::rename(&base.0, base.0.with_extension("moved")).unwrap();
                fs::create_dir(&base.0).unwrap();
            }
        }
        assert!(image.validate().is_err(), "change {change}");
        if change == 4 {
            fs::remove_dir(&base.0).unwrap();
            fs::rename(base.0.with_extension("moved"), &base.0).unwrap();
        }
    }
}

#[test]
fn same_inode_same_length_valid_shape_rewrite_is_not_accepted_as_unchanged() {
    let base = setup();
    let path = base.0.join("generation/helper");
    chmod(&path, 0o755);
    let image = inspect(&base).unwrap();
    let mut bytes = thin_bytes();
    *bytes.last_mut().unwrap() = 1; // opaque load-command payload, shape still valid
    fs::write(&path, &bytes).unwrap();
    // Force a deterministic metadata delta, without sleeps/timestamp granularity assumptions.
    File::open(&path)
        .unwrap()
        .set_times(
            fs::FileTimes::new().set_modified(
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1),
            ),
        )
        .unwrap();
    let leaf = image.nodes.last().unwrap();
    super::super::macho::validate(&leaf.file, bytes.len() as u64).unwrap();
    assert!(image.validate().is_err()); // actual metadata changed; no digest claim
}

#[test]
fn losing_cloexec_refuses_even_when_names_bytes_and_permissions_still_match() {
    let base = setup();
    let image = inspect(&base).unwrap();
    let leaf = image.nodes.last().unwrap();
    // SAFETY: changes only this fixture-owned descriptor; no child is launched.
    assert_eq!(
        unsafe { libc::fcntl(leaf.file.as_raw_fd(), libc::F_SETFD, 0) },
        0
    );
    assert!(image.validate().is_err());
}

#[test]
fn named_inode_check_is_independent_of_retained_descriptor_metadata_checks() {
    let base = setup();
    let mut image = inspect(&base).unwrap();
    image.validate().unwrap();
    fs::rename(
        base.0.join("generation/helper"),
        base.0.join("generation/retained"),
    )
    .unwrap();
    fs::write(base.0.join("generation/helper"), thin_bytes()).unwrap();
    chmod(&base.0.join("generation/helper"), 0o555);
    // Deliberately refresh only this private fixture's metadata baselines so
    // conservative directory/file ctime guards cannot mask a missing name check.
    // Production has no baseline refresh or descriptor getter.
    for (index, node) in image.nodes.iter_mut().enumerate() {
        node.snapshot = Snapshot::read(&node.file, image.uid, index == 1).unwrap();
    }
    let leaf = image.nodes.last().unwrap();
    super::super::macho::validate(&leaf.file, leaf.snapshot.length().unwrap()).unwrap();
    assert!(image.validate().is_err());
}

#[test]
fn symlinked_ancestor_and_fifo_refuse_without_following_or_blocking() {
    let base = setup();
    fs::rename(base.0.join("generation"), base.0.join("real")).unwrap();
    symlink(base.0.join("real"), base.0.join("generation")).unwrap();
    assert!(inspect(&base).is_err());
    fs::remove_file(base.0.join("generation")).unwrap();
    fs::rename(base.0.join("real"), base.0.join("generation")).unwrap();
    fs::remove_file(base.0.join("generation/helper")).unwrap();
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(base.0.join("generation/helper").as_os_str().as_bytes()).unwrap();
    // SAFETY: NUL-terminated private fixture path; creates no process or writer.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o500) }, 0);
    assert!(inspect(&base).is_err()); // O_NONBLOCK open + regular-type refusal
}
