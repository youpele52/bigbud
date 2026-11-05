//! Descriptor-relative durable journal with retained destination identity. A
//! process-local mutex serializes threads sharing the one OS election lock.
use super::{Journal, JournalError, MAX_RECORD_BYTES, SafetyRecord, codec};
use crate::native_fs::{
    descriptor::{same_named, stat},
    storage,
};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Seek, Write},
    os::fd::AsRawFd,
    sync::{
        MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static BEFORE_STATE: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

impl Journal<'_> {
    // Per-thread, private fixture checkpoint immediately before the ACTUAL
    // journal mutex acquisition. No production callback or I/O fake exists.
    #[cfg(test)]
    pub(in crate::guard) fn fixture_before_state(checkpoint: impl Fn() + 'static) {
        BEFORE_STATE.with(|slot| *slot.borrow_mut() = Some(Box::new(checkpoint)));
    }
    fn state(&self) -> Result<MutexGuard<'_, Option<File>>, JournalError> {
        #[cfg(test)]
        BEFORE_STATE.with(|slot| {
            if let Some(checkpoint) = slot.borrow().as_ref() {
                checkpoint();
            }
        });
        self.lock
            .journal_file
            .lock()
            .map_err(|_| JournalError::Invalid)
    }
    fn validate(&self, state: Option<&File>) -> Result<(), JournalError> {
        self.lock.validate()?;
        storage::validate_optional(
            self.lock.root.directory(),
            c"safety.v1",
            state,
            self.lock.root.uid(),
        )
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                JournalError::Invalid
            } else {
                error.into()
            }
        })?;
        Ok(())
    }
    pub fn read(&self) -> Result<Option<SafetyRecord>, JournalError> {
        let mut state = self.state()?;
        self.validate(state.as_ref())?;
        let Some(file) = state.as_mut() else {
            return Ok(None);
        };
        if file.metadata()?.len() > MAX_RECORD_BYTES as u64 {
            return Err(JournalError::Invalid);
        }
        file.rewind()?;
        let mut bytes = Vec::new();
        file.take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        self.validate(state.as_ref())?;
        codec::decode(&bytes).map(Some)
    }

    pub fn replace(&self, record: &SafetyRecord) -> Result<(), JournalError> {
        let bytes = codec::encode(record)?;
        let mut state = self.state()?;
        self.validate(state.as_ref())?;
        let sequence = SEQUENCE
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
            .map_err(|_| JournalError::Invalid)?;
        let name = CString::new(format!("safety.v1.{}.{}.tmp", std::process::id(), sequence))
            .map_err(|_| JournalError::Invalid)?;
        let directory = self.lock.root.directory();
        let mut file = storage::open(
            directory,
            &name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        )?;
        let result = (|| -> Result<(), JournalError> {
            storage::validate(directory, &name, &file, self.lock.root.uid())?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            self.validate(state.as_ref())?;
            storage::validate(directory, &name, &file, self.lock.root.uid())?;
            // SAFETY: both fixed single-component names are relative to the
            // retained validated root. Other UIDs cannot mutate this directory.
            // Name checks do NOT promise atomic protection from hostile same UID.
            if unsafe {
                libc::renameat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    directory.as_raw_fd(),
                    c"safety.v1".as_ptr(),
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(())
        })();
        if let Err(error) = result {
            // Preserve ambiguous/replaced names. Only remove our exact temporary;
            // a cleanup failure does not erase the original failed transaction.
            if same_named(directory, &name, &stat(&file)?).is_ok() {
                // SAFETY: retained directory and observed owned temporary inode;
                // no recursive cleanup or deletion of safety.v1/controller.lock.
                let _cleanup_status =
                    unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) };
            }
            return Err(error);
        }
        // After rename, retain the new inode even if the durability flush fails.
        // A failed flush is an error/uncertain persistence, never successful ack.
        *state = Some(file);
        directory.sync_all()?;
        self.validate(state.as_ref())
    }
}
