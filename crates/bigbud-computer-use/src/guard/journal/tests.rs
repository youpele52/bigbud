use super::*;
use crate::guard::{
    record::NoticeState,
    test_support::{TestDirectory, armed},
};
use std::fs;

#[test]
fn codec_preserves_complete_safety_metadata_without_policy_or_content() {
    let record = armed();
    let bytes = codec::encode(&record).unwrap();
    assert_eq!(codec::decode(&bytes).unwrap(), record);
    let mut acked = record;
    acked.notice.as_mut().unwrap().state = NoticeState::Acked;
    assert_eq!(
        codec::decode(&codec::encode(&acked).unwrap()).unwrap(),
        acked
    );
}
#[test]
fn codec_refuses_corrupt_future_partial_and_noncanonical_safety_records() {
    let bytes = codec::encode(&armed()).unwrap();
    for bad in [
        vec![],
        bytes.get(..bytes.len() - 1).unwrap().to_vec(),
        String::from_utf8(bytes.clone())
            .unwrap()
            .replace("safety\t1", "safety\t2")
            .into_bytes(),
        String::from_utf8(bytes.clone())
            .unwrap()
            .replace("0\t1\tinitial", "00\t1\tinitial")
            .into_bytes(),
        vec![b'x'; MAX_RECORD_BYTES + 1],
    ] {
        assert!(codec::decode(&bad).is_err());
    }
    let mut invalid = armed();
    invalid.reason = "bad\nreason".into();
    assert!(codec::encode(&invalid).is_err());
    let mut duplicate = armed();
    duplicate
        .roots
        .push(duplicate.roots.first().unwrap().clone());
    assert!(codec::encode(&duplicate).is_err());
}
#[test]
#[cfg(not(windows))]
fn bounded_atomic_file_round_trip_and_corruption_does_not_default() {
    let directory = TestDirectory::new();
    let lock = crate::guard::ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    let journal = lock.journal();
    assert_eq!(journal.read().unwrap(), None);
    journal.replace(&armed()).unwrap();
    assert_eq!(journal.read().unwrap(), Some(armed()));
    let mut changed = armed();
    changed.pause_epoch = 17;
    journal.replace(&changed).unwrap();
    assert_eq!(journal.read().unwrap(), Some(changed));
    fs::write(directory.0.join("safety.v1"), b"corrupt").unwrap();
    assert!(journal.read().is_err());
    assert_eq!(fs::read(directory.0.join("safety.v1")).unwrap(), b"corrupt");
}
#[test]
#[cfg(unix)]
fn refuses_symlink_journal_without_touching_destination() {
    use std::os::unix::fs::symlink;
    let directory = TestDirectory::new();
    let lock = crate::guard::ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    let journal = lock.journal();
    let target = directory.0.join("other");
    fs::write(&target, b"untouched").unwrap();
    symlink(&target, directory.0.join("safety.v1")).unwrap();
    assert!(journal.read().is_err());
    assert!(journal.replace(&armed()).is_err());
    assert_eq!(fs::read(target).unwrap(), b"untouched");
}

#[test]
fn oversized_storage_refuses_instead_of_recovering_defaults() {
    let directory = TestDirectory::new();
    let lock = crate::guard::ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    let journal = lock.journal();
    let path = directory.0.join("safety.v1");
    #[cfg(not(windows))]
    journal.replace(&armed()).unwrap();
    // Windows deliberately has no durable replacement implementation.
    #[cfg(windows)]
    fs::write(&path, codec::encode(&armed()).unwrap()).unwrap();
    assert_eq!(journal.read().unwrap(), Some(armed()));

    use std::io::Write;
    let oversized = vec![b'x'; MAX_RECORD_BYTES + 1];
    let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.write_all(&oversized).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            file.metadata().unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }
    #[cfg(target_os = "macos")]
    let mut retained = {
        use crate::native_fs::storage;
        use std::io::{Seek, SeekFrom};
        let state = lock.journal_file.lock().unwrap();
        // Exercise every pre-size guard on the retained inode after enlargement:
        // identity/owner/mode/ACL refusal must not mask the size regression.
        lock.validate().unwrap();
        storage::validate_optional(
            lock.root.directory(),
            c"safety.v1",
            state.as_ref(),
            lock.root.uid(),
        )
        .unwrap();
        let mut retained = state.as_ref().unwrap().try_clone().unwrap();
        assert_eq!(retained.metadata().unwrap().len(), oversized.len() as u64);
        // Clones share the retained descriptor's offset. Early size rejection
        // must leave this sentinel untouched, unlike rewind/read/codec refusal.
        retained.seek(SeekFrom::Start(1)).unwrap();
        retained
    };
    assert!(matches!(journal.read(), Err(JournalError::Invalid)));
    #[cfg(target_os = "macos")]
    {
        use std::io::Seek;
        assert_eq!(
            retained.stream_position().unwrap(),
            1,
            "must reject before reading"
        );
    }
    assert_eq!(fs::read(&path).unwrap(), oversized);
}
