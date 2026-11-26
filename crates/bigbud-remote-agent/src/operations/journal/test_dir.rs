//! Private per-test journal directories.
//!
//! A journal scans its parent directory for its own temporary files and fails closed once that
//! inventory exceeds a bound, so tests must never place journals directly in the shared temp
//! root, whose contents are unbounded and outside the test's control.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIR_ID: AtomicU64 = AtomicU64::new(0);

/// A private, uniquely named directory removed with its contents on drop.
pub(crate) struct JournalTestDir(PathBuf);

impl JournalTestDir {
    pub(crate) fn new(label: &str) -> Self {
        loop {
            let id = NEXT_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "bigbud-journal-{label}-{}-{id}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                            .expect("journal test directory permissions");
                    }
                    return Self(path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed to create journal test directory: {error}"),
            }
        }
    }

    /// Creates a private directory and returns it with a journal path inside it.
    pub(crate) fn with_journal(label: &str) -> (Self, PathBuf) {
        let dir = Self::new(label);
        let path = dir.0.join("operations.journal");
        (dir, path)
    }
}

impl Drop for JournalTestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
