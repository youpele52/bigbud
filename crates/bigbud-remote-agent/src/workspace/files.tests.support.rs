//! Shared fixtures for the Unix write-path tests: temporary roots, directory listings, held
//! `flock`s and the write-path seams.
#![cfg(unix)]

use std::fs;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::files_seams::{AFTER_SYNC_HOOK, BEFORE_COMMIT_HOOK, FAULTS, Fault, LOCK_TIMEOUT};

pub(super) struct TestRoot(pub(super) PathBuf);

static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);

impl TestRoot {
    pub(super) fn new() -> Self {
        loop {
            let suffix = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "bigbud-agent-write-test-{}-{suffix}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed to create test root: {error}"),
            }
        }
    }

    /// Every entry below the root, relative and sorted.
    pub(super) fn entries(&self) -> Vec<String> {
        let mut names = walk(&self.0)
            .into_iter()
            .map(|entry| {
                entry
                    .strip_prefix(&self.0)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    /// Entries other than per-path lock files.
    pub(super) fn entries_without_locks(&self) -> Vec<String> {
        self.entries()
            .into_iter()
            .filter(|entry| !file_name(entry).starts_with(".bigbud-lock-"))
            .collect()
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn file_name(entry: &str) -> &str {
    entry.rsplit('/').next().unwrap_or(entry)
}

fn walk(directory: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(walk(&path));
        }
        found.push(path);
    }
    found
}

/// The per-path lock file name for a normalized workspace-relative path.
pub(super) fn lock_file_name(relative_path: &str) -> String {
    format!(
        ".bigbud-lock-{}",
        super::content_sha256(relative_path.as_bytes())
    )
}

/// Opens `path` (a directory or a lock file, created if missing) and holds `LOCK_EX` on it
/// until the returned file is dropped, like a concurrent writer would.
pub(super) fn hold_flock(path: &Path) -> fs::File {
    let file = if path.is_dir() {
        fs::File::open(path).unwrap()
    } else {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .unwrap()
    };
    // SAFETY: The file owns a valid descriptor for the duration of flock.
    assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }, 0);
    file
}

/// Installs write-path seams on the current thread and clears them all when dropped.
pub(super) struct Seams;

impl Seams {
    pub(super) fn new() -> Self {
        Self
    }

    pub(super) fn before_commit(&self, hook: impl FnOnce() + 'static) -> &Self {
        BEFORE_COMMIT_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        self
    }

    pub(super) fn after_sync(&self, hook: impl FnOnce(&fs::File) + 'static) -> &Self {
        AFTER_SYNC_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        self
    }

    pub(super) fn fault(&self, fault: Fault, errno: i32) -> &Self {
        FAULTS.with(|faults| faults.borrow_mut().push((fault, errno)));
        self
    }

    pub(super) fn lock_timeout(&self, timeout: Duration) -> &Self {
        LOCK_TIMEOUT.with(|slot| slot.set(Some(timeout)));
        self
    }
}

impl Drop for Seams {
    fn drop(&mut self) {
        BEFORE_COMMIT_HOOK.with(|slot| *slot.borrow_mut() = None);
        AFTER_SYNC_HOOK.with(|slot| *slot.borrow_mut() = None);
        FAULTS.with(|faults| faults.borrow_mut().clear());
        LOCK_TIMEOUT.with(|slot| slot.set(None));
    }
}

/// A group the test user belongs to other than `excluded`, if any.
pub(super) fn supplementary_group_other_than(excluded: u32) -> Option<u32> {
    let mut groups = vec![0 as libc::gid_t; 256];
    // SAFETY: The buffer holds `groups.len()` writable gid_t entries.
    let count = unsafe { libc::getgroups(groups.len() as libc::c_int, groups.as_mut_ptr()) };
    let count = usize::try_from(count).ok()?;
    groups.truncate(count);
    groups.into_iter().find(|group| *group != excluded)
}
