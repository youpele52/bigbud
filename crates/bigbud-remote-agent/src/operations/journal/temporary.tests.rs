#![allow(clippy::unwrap_used, clippy::panic)]
use super::*;
use crate::operations::{JournalRecord, OperationJournal, OperationState};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "bigbud-journal-temp-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let result = Self(root);
        OperationJournal::open(result.path(), 4096).unwrap();
        result
    }
    fn path(&self) -> PathBuf {
        self.0.join("operations.journal")
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn child(&self, mode: &str) -> Child {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "operations::journal::temporary::tests::guard_child",
                "--nocapture",
            ])
            .env("BIGBUD_TEST_JOURNAL_ROOT", &self.0)
            .env("BIGBUD_TEST_JOURNAL_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn busy<T>(result: Result<T>) -> bool {
    matches!(result, Err(OperationJournalError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock)
}
fn dead_pid() -> u32 {
    let mut child = Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}
fn wait_child(mut child: Child) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            return;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("journal child timed out");
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn legacy_and_partial_fixed_temps_recover_without_altering_current_or_other_history() {
    let fixture = Fixture::new();
    let before = fs::read(fixture.path()).unwrap();
    fixture.write(
        &format!(".operations.journal.compact-{}-123", dead_pid()),
        MAGIC,
    );
    fixture.write(".operations.journal.compact", b"BB");
    fixture.write(".other.journal.compact-2-123", b"unrelated history");
    OperationJournal::open(fixture.path(), 4096).unwrap();
    assert_eq!(fs::read(fixture.path()).unwrap(), before);
    assert!(!fixture.0.join(".operations.journal.compact").exists());
    assert_eq!(
        fs::read(fixture.0.join(".other.journal.compact-2-123")).unwrap(),
        b"unrelated history"
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 3);
}

#[test]
fn live_or_ambiguous_legacy_owner_defers_before_tail_repair_or_any_temp_deletion() {
    let fixture = Fixture::new();
    fixture.write("operations.journal", b"BBRJ1\0\0");
    fixture.write(".operations.journal.compact", MAGIC);
    let live = format!(".operations.journal.compact-{}-456", std::process::id());
    fixture.write(&live, MAGIC);
    assert!(matches!(
        OperationJournal::open(fixture.path(), 4096),
        Err(OperationJournalError::CompactionDeferred(_))
    ));
    assert_eq!(fs::read(fixture.path()).unwrap(), b"BBRJ1\0\0");
    assert!(fixture.0.join(".operations.journal.compact").exists());
    fs::remove_file(fixture.0.join(live)).unwrap();
    fixture.write(".operations.journal.compact-unknown", MAGIC);
    assert!(OperationJournal::open(fixture.path(), 4096).is_err());
    assert_eq!(fs::read(fixture.path()).unwrap(), b"BBRJ1\0\0");
}

#[test]
fn missing_or_corrupt_current_keeps_temporary_evidence() {
    for missing in [true, false] {
        let fixture = Fixture::new();
        fixture.write(".operations.journal.compact", MAGIC);
        if missing {
            fs::remove_file(fixture.path()).unwrap();
        } else {
            fixture.write("operations.journal", b"wrong");
        }
        assert!(OperationJournal::open(fixture.path(), 4096).is_err());
        assert_eq!(
            fs::read(fixture.0.join(".operations.journal.compact")).unwrap(),
            MAGIC
        );
        if missing {
            assert!(!fixture.path().exists());
        } else {
            assert_eq!(fs::read(fixture.path()).unwrap(), b"wrong");
        }
    }
}

#[test]
fn unsafe_objects_and_budget_excess_defer_without_sweeping() {
    for kind in [
        "symlink", "hardlink", "public", "oversize", "header", "count",
    ] {
        let fixture = Fixture::new();
        let before = fs::read(fixture.path()).unwrap();
        fixture.write("foreign", MAGIC);
        let slot = fixture.0.join(".operations.journal.compact");
        match kind {
            "symlink" => symlink(fixture.0.join("foreign"), &slot).unwrap(),
            "hardlink" => fs::hard_link(fixture.0.join("foreign"), &slot).unwrap(),
            "public" => {
                fs::write(&slot, MAGIC).unwrap();
                fs::set_permissions(&slot, fs::Permissions::from_mode(0o644)).unwrap();
            }
            "oversize" => fixture.write(".operations.journal.compact", &vec![b'x'; 4097]),
            "header" => fixture.write(".operations.journal.compact", b"foreign"),
            "count" => {
                let pid = dead_pid();
                for index in 0..=MAX_RECOVERY_FILES {
                    fixture.write(&format!(".operations.journal.compact-{pid}-{index}"), MAGIC);
                }
            }
            _ => panic!("bad fixture"),
        }
        let count = fs::read_dir(&fixture.0).unwrap().count();
        assert!(OperationJournal::open(fixture.path(), 4096).is_err());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), count);
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
        assert_eq!(fs::read(fixture.0.join("foreign")).unwrap(), MAGIC);
    }
}

#[test]
fn repeated_interrupted_publication_retains_one_capped_slot_and_current_authority() {
    let fixture = Fixture::new();
    let before = fs::read(fixture.path()).unwrap();
    for _ in 0..8 {
        let guard = Guard::acquire(&fixture.path()).unwrap();
        let current = guard.current(false).unwrap();
        let error = guard
            .replace_with(
                &current,
                &[MAGIC.to_vec()],
                4096,
                || Err(std::io::Error::from_raw_os_error(libc::ENOSPC).into()),
                || Ok(()),
            )
            .unwrap_err();
        assert!(matches!(error, OperationJournalError::Io(_)));
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
        assert_eq!(
            fs::metadata(fixture.0.join(".operations.journal.compact"))
                .unwrap()
                .len(),
            MAGIC.len() as u64
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 3);
        drop(guard);
        OperationJournal::open(fixture.path(), 4096).unwrap();
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2);
    }
}

#[test]
fn post_rename_guard_excludes_thread_and_process_admission_until_directory_sync() {
    let fixture = Fixture::new();
    let journal = OperationJournal::open(fixture.path(), 4096).unwrap();
    let guard = Guard::acquire(&fixture.path()).unwrap();
    let current = guard.current(false).unwrap();
    let records = [
        JournalRecord::Accepted {
            operation_id: "replacement".into(),
            request_digest: vec![1],
        },
        JournalRecord::Completed {
            operation_id: "replacement".into(),
            state: OperationState::Completed,
            exit_code: Some(0),
            error_code: None,
        },
    ];
    let mut chunks = vec![MAGIC.to_vec()];
    for record in &records {
        super::super::codec::append_encoded(&mut chunks, record).unwrap();
    }
    let mut contender = None;
    let mut thread_blocked = false;
    guard
        .replace_with(
            &current,
            &chunks,
            4096,
            || Ok(()),
            || {
                assert!(!fixture.0.join(".operations.journal.compact").exists());
                let path = fixture.path();
                let (sent, received) = std::sync::mpsc::sync_channel(1);
                contender = Some(thread::spawn(move || {
                    let _observer_gone = sent.send(busy(OperationJournal::open(path, 4096)));
                }));
                thread_blocked = received.recv_timeout(Duration::from_secs(1)) == Ok(true);
                assert!(busy(OperationJournal::open(fixture.path(), 4096)));
                assert!(busy(journal.records()));
                assert!(busy(journal.append(&records[0])));
                assert!(busy(journal.compact()));
                wait_child(fixture.child("attempt"));
                Ok(())
            },
        )
        .unwrap();
    drop(guard);
    if let Some(contender) = contender {
        contender.join().unwrap();
    }
    assert!(
        thread_blocked,
        "post-rename thread admission bypassed the stable guard"
    );
    assert_eq!(
        OperationJournal::open(fixture.path(), 4096)
            .unwrap()
            .records()
            .unwrap(),
        records
    );
}

#[test]
fn guard_survives_temp_rename_and_releases_after_owner_process_exit() {
    let fixture = Fixture::new();
    let mut child = fixture.child("hold");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !fixture.0.join("ready").exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let ready = fixture.0.join("ready").exists();
    let blocked = busy(OperationJournal::open(fixture.path(), 4096));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(ready && blocked);
    OperationJournal::open(fixture.path(), 4096).unwrap();
}

#[test]
fn unsafe_guard_is_not_replaced_or_truncated() {
    let fixture = Fixture::new();
    let lock = fixture.0.join(".operations.journal.lock");
    fixture.write("guard-evidence", b"preserve");
    fs::remove_file(&lock).unwrap();
    symlink(fixture.0.join("guard-evidence"), &lock).unwrap();
    assert!(OperationJournal::open(fixture.path(), 4096).is_err());
    assert_eq!(
        fs::read(fixture.0.join("guard-evidence")).unwrap(),
        b"preserve"
    );
}

#[test]
fn guard_child() {
    let Some(root) = std::env::var_os("BIGBUD_TEST_JOURNAL_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let path = root.join("operations.journal");
    if std::env::var("BIGBUD_TEST_JOURNAL_MODE").unwrap() == "attempt" {
        assert!(busy(OperationJournal::open(path, 4096)));
        return;
    }
    let _guard = Guard::acquire(&path).unwrap();
    fs::write(root.join("ready"), b"ready").unwrap();
    thread::sleep(Duration::from_secs(10));
}

#[test]
fn directory_inventory_is_bounded_and_each_scan_starts_fresh() {
    let fixture = Fixture::new();
    let guard = Guard::acquire(&fixture.path()).unwrap();
    assert!(matches!(
        guard.entries_up_to(1),
        Err(OperationJournalError::CompactionDeferred(_))
    ));
    assert_eq!(guard.entries().unwrap().len(), 2);
    assert_eq!(guard.entries().unwrap().len(), 2);
    assert_eq!(fs::read(fixture.path()).unwrap(), MAGIC);
}

#[test]
fn replaced_guard_identity_refuses_further_writable_access() {
    let fixture = Fixture::new();
    let guard = Guard::acquire(&fixture.path()).unwrap();
    fs::rename(
        fixture.0.join(".operations.journal.lock"),
        fixture.0.join("original-guard"),
    )
    .unwrap();
    fixture.write(".operations.journal.lock", b"");
    assert!(matches!(
        guard.current(false),
        Err(OperationJournalError::CompactionDeferred(_))
    ));
    assert_eq!(fs::read(fixture.path()).unwrap(), MAGIC);
}

#[test]
fn post_rename_failure_never_rolls_back_or_promotes_a_temporary() {
    let fixture = Fixture::new();
    let guard = Guard::acquire(&fixture.path()).unwrap();
    let current = guard.current(false).unwrap();
    let result = guard.replace_with(
        &current,
        &[MAGIC.to_vec()],
        4096,
        || Ok(()),
        || Err(std::io::Error::from_raw_os_error(libc::EIO).into()),
    );
    assert!(result.is_err());
    assert!(busy(OperationJournal::open(fixture.path(), 4096)));
    assert!(!fixture.0.join(".operations.journal.compact").exists());
    drop(guard);
    assert!(
        OperationJournal::open(fixture.path(), 4096)
            .unwrap()
            .records()
            .unwrap()
            .is_empty()
    );
}

#[path = "temporary.authority.tests.rs"]
mod authority;
