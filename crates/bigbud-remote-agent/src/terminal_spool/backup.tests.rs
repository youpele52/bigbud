use std::process::Command;

use super::store_tests::{small_limits, temp_root};
use super::{
    BACKUP_EXCLUDE_PLIST, BackupExclusion, SpoolStore, exclude_from_backup,
    is_excluded_from_backup, read_backup_xattr,
};

#[test]
fn opening_the_store_sets_the_binary_plist_exclusion_xattr() {
    let root = temp_root("timemachine");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    assert_eq!(
        store.backup_exclusion(),
        Some(&Ok(BackupExclusion::Xattr)),
        "the xattr path should succeed on a local volume"
    );
    assert_eq!(
        read_backup_xattr(&root).unwrap().as_deref(),
        Some(&BACKUP_EXCLUDE_PLIST[..])
    );
    assert!(
        is_excluded_from_backup(&root).unwrap(),
        "tmutil isexcluded must agree"
    );
    // Re-applying is idempotent.
    assert_eq!(exclude_from_backup(&root).unwrap(), BackupExclusion::Xattr);
}

#[test]
fn the_plist_matches_what_tmutil_addexclusion_writes() {
    let root = temp_root("tmutil-reference");
    std::fs::create_dir_all(&root).unwrap();
    let status = Command::new("/usr/bin/tmutil")
        .arg("addexclusion")
        .arg(&root)
        .status()
        .unwrap();
    if !status.success() {
        eprintln!("skipping: tmutil addexclusion is not permitted here ({status})");
        return;
    }
    assert_eq!(
        read_backup_xattr(&root).unwrap().as_deref(),
        Some(&BACKUP_EXCLUDE_PLIST[..])
    );
}
