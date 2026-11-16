//! Writable Unix journal transactions only. Read-only inspection never enters
//! this module. The existing single-AgentSession owner invariant still applies.
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;

use super::{MAGIC, OperationJournalError};

#[path = "temporary.guard.rs"]
mod guard;
pub(super) use guard::Guard;

type Result<T> = std::result::Result<T, OperationJournalError>;
const MAX_RECOVERY_FILES: usize = 16;
pub(super) struct Recovery(Vec<(CString, File)>);

impl Recovery {
    pub(super) fn has_candidates(&self) -> bool {
        !self.0.is_empty()
    }
}

impl Guard {
    /// Preflight the entire bounded inventory before removing ANY candidate.
    /// Busy/ambiguous legacy ownership is an explicit deferral, not permission
    /// to mutate current history or allocate another compaction generation.
    pub(super) fn inspect_temporaries(&self, maximum: usize) -> Result<Recovery> {
        let fixed = self.sibling(b".compact")?;
        let legacy = self.sibling(b".compact-")?;
        let mut candidates = Vec::new();
        let mut total = 0u64;
        for name in self.entries()? {
            let is_fixed = name == fixed;
            if !is_fixed && !name.as_bytes().starts_with(legacy.as_bytes()) {
                continue;
            }
            if candidates.len() == MAX_RECOVERY_FILES {
                return Err(OperationJournalError::CompactionDeferred(
                    "temporary-file count budget exceeded",
                ));
            }
            if !is_fixed {
                let suffix = name
                    .as_bytes()
                    .get(legacy.as_bytes().len()..)
                    .ok_or(OperationJournalError::Corrupt("invalid temporary name"))?;
                let suffix = std::str::from_utf8(suffix).map_err(|_| {
                    OperationJournalError::CompactionDeferred("unrecognized temporary name")
                })?;
                let (pid, stamp) =
                    suffix
                        .split_once('-')
                        .ok_or(OperationJournalError::CompactionDeferred(
                            "unrecognized temporary name",
                        ))?;
                if !pid.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(OperationJournalError::CompactionDeferred(
                        "unrecognized temporary PID",
                    ));
                }
                let pid = pid.parse::<i32>().ok().filter(|pid| *pid > 1).ok_or(
                    OperationJournalError::CompactionDeferred("unrecognized temporary PID"),
                )?;
                if stamp.is_empty()
                    || !stamp.bytes().all(|byte| byte.is_ascii_digit())
                    || stamp.parse::<u128>().is_err()
                {
                    return Err(OperationJournalError::CompactionDeferred(
                        "unrecognized temporary timestamp",
                    ));
                }
                // SAFETY: signal zero observes liveness only. Live, reused and
                // permission-unknown PIDs retain their files; only ESRCH admits.
                let status = unsafe { libc::kill(pid, 0) };
                if status == 0
                    || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                {
                    return Err(OperationJournalError::CompactionDeferred(
                        "legacy temporary owner is live or unknown",
                    ));
                }
            }
            let mut file = self.open(&name, false, false)?;
            let size = file.metadata()?.len();
            if size > maximum as u64 {
                return Err(OperationJournalError::CompactionDeferred(
                    "temporary file exceeds journal cap",
                ));
            }
            total = total
                .checked_add(size)
                .ok_or(OperationJournalError::RecordTooLarge)?;
            if total > (maximum as u64).saturating_mul(MAX_RECOVERY_FILES as u64) {
                return Err(OperationJournalError::CompactionDeferred(
                    "temporary-file byte budget exceeded",
                ));
            }
            let mut prefix = [0; MAGIC.len()];
            let count = size.min(MAGIC.len() as u64) as usize;
            let read = prefix
                .get_mut(..count)
                .ok_or(OperationJournalError::Corrupt(
                    "invalid temporary header length",
                ))?;
            file.read_exact(read)?;
            if !MAGIC.starts_with(read) {
                return Err(OperationJournalError::CompactionDeferred(
                    "temporary header is unrecognized",
                ));
            }
            candidates.push((name, file));
        }
        Ok(Recovery(candidates))
    }

    pub(super) fn require_current_for_recovery(&self, recovery: &Recovery) -> Result<()> {
        if !recovery.0.is_empty() {
            // Absent current plus temp data is not a fresh journal. Never
            // initialize empty history over possible recovery evidence.
            self.current(false)?;
        }
        Ok(())
    }

    pub(super) fn recover(&self, recovery: Recovery) -> Result<()> {
        for (name, file) in &recovery.0 {
            self.remove(name, file)?;
        }
        if !recovery.0.is_empty() {
            self.directory.sync_all()?;
        }
        Ok(())
    }

    pub(super) fn replace(&self, current: &File, chunks: &[Vec<u8>], maximum: usize) -> Result<()> {
        self.replace_with(current, chunks, maximum, || Ok(()), || Ok(()))
    }

    /// The hook isolates the post-rename/pre-directory-sync boundary for tests;
    /// production uses an empty hook and holds the same stable guard throughout.
    fn replace_with(
        &self,
        current: &File,
        chunks: &[Vec<u8>],
        maximum: usize,
        before_rename: impl FnOnce() -> Result<()>,
        after_rename: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let size = chunks
            .iter()
            .try_fold(0usize, |total, chunk| total.checked_add(chunk.len()))
            .ok_or(OperationJournalError::RecordTooLarge)?;
        if size > maximum {
            return Err(OperationJournalError::Full { maximum });
        }
        self.same_named(&self.basename, current)?;
        let name = self.sibling(b".compact")?;
        // create_new: never truncate a live/unknown leftover to force progress.
        // Error/crash leaves at most this single bounded, private slot. Recovery
        // is deferred to the next guarded transaction, never promote its data.
        let mut file = self.open(&name, true, true)?;
        for bytes in chunks {
            file.write_all(bytes)?;
        }
        file.sync_all()?;
        before_rename()?;
        self.same_named(&name, &file)?;
        self.same_named(&self.basename, current)?;
        // SAFETY: both basenames and directory descriptors are live and pinned.
        // The never-renamed guard excludes cooperating recovery/writers across
        // this rename; identity rechecks alone are NOT conditional unlink.
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                self.directory.as_raw_fd(),
                self.basename.as_ptr(),
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        after_rename()?;
        self.directory.sync_all()?;
        Ok(())
    }

    fn remove(&self, name: &CString, file: &File) -> Result<()> {
        self.same_named(name, file)?;
        // SAFETY: the guard excludes supported mutation; name is an inventoried
        // basename in the pinned directory. Never follow links or recurse.
        if unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "temporary.tests.rs"]
mod tests;
