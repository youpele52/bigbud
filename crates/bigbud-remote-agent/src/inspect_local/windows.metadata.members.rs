//! Experimental class-47 query on independently opened synchronous local filesystem handles only.
use std::{
    fs::File,
    io,
    mem::{offset_of, size_of},
    os::windows::io::AsRawHandle,
};
use windows_sys::{
    Wdk::Storage::FileSystem::{FileProcessIdsUsingFileInformation, NtQueryInformationFile},
    Win32::{
        Foundation::*,
        System::{
            IO::IO_STATUS_BLOCK,
            Threading::{INFINITE, WaitForSingleObject},
        },
    },
};

// windows-sys 0.61.2 Wdk/System/SystemServices: ULONG followed by aligned ULONG_PTR[1].
#[repr(C)]
struct ProcessIds {
    count: u32,
    ids: [usize; 1],
}
const OFFSET: usize = offset_of!(ProcessIds, ids);
const MAX_IDS: usize = 4096;

fn decode(words: &[usize], written: usize, pid: u32) -> io::Result<bool> {
    if written < OFFSET || written > size_of_val(words) {
        return Err(io::Error::other("class47 length bound"));
    }
    let count = words
        .first()
        .ok_or_else(|| io::Error::other("class47 empty buffer"))?
        & u32::MAX as usize;
    if count > MAX_IDS || OFFSET + count * size_of::<usize>() > written {
        return Err(io::Error::other("class47 truncated inventory"));
    }
    let start = OFFSET / size_of::<usize>();
    let ids = words
        .get(start..start + count)
        .ok_or_else(|| io::Error::other("class47 array bound"))?;
    if ids.iter().any(|id| *id == 0 || *id > u32::MAX as usize) {
        return Err(io::Error::other("class47 invalid pid"));
    }
    Ok(ids.contains(&(pid as usize)))
}

/// The caller must use open_checked's synchronous, metadata-only handle; no remote handle accepted.
pub(super) fn contains(file: &File, pid: u32) -> io::Result<bool> {
    for capacity in [16, 64, 256, 1024, MAX_IDS] {
        let bytes = OFFSET + capacity * size_of::<usize>();
        let mut words = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let mut iosb = IO_STATUS_BLOCK::default();
        // SAFETY: live independently opened synchronous File, aligned bounded output and live IOSB.
        let mut status = unsafe {
            NtQueryInformationFile(
                file.as_raw_handle(),
                &mut iosb,
                words.as_mut_ptr().cast(),
                bytes as u32,
                FileProcessIdsUsingFileInformation,
            )
        };
        if status == STATUS_PENDING {
            // Keep the output alive even if a driver unexpectedly pends this synchronous query.
            // The disposable probe process has an external deadline; never drop pending I/O buffers.
            // SAFETY: this local handle has SYNCHRONIZE and both buffers remain live until completion.
            if unsafe { WaitForSingleObject(file.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 {
                // Terminating our own probe is the only safe exit if completion cannot be established.
                std::process::abort();
            }
            // SAFETY: the completed IOSB contains its NTSTATUS union member.
            status = unsafe { iosb.Anonymous.Status };
        }
        if status == STATUS_PENDING {
            // Completion could not be established: never release buffers still owned by the kernel.
            std::process::abort();
        }
        // SAFETY: the call completed; verify IOSB status independently before parsing its byte count.
        if let Some(value) = response(
            status,
            unsafe { iosb.Anonymous.Status },
            &words,
            iosb.Information,
            pid,
        )? {
            return Ok(value);
        }
    }
    Err(io::Error::other("class47 capacity exhausted"))
}

fn response(
    status: NTSTATUS,
    completion: NTSTATUS,
    words: &[usize],
    written: usize,
    pid: u32,
) -> io::Result<Option<bool>> {
    if matches!(
        status,
        STATUS_INFO_LENGTH_MISMATCH | STATUS_BUFFER_TOO_SMALL | STATUS_BUFFER_OVERFLOW
    ) {
        return Ok(None);
    }
    if status != STATUS_SUCCESS {
        eprintln!("metadata prototype class47 status={status:#x}");
        // SAFETY: numeric NTSTATUS conversion only, no arbitrary paths/data serialized.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    if completion != STATUS_SUCCESS {
        return Err(io::Error::other("class47 incomplete query"));
    }
    decode(words, written, pid).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_membership_never_counts_as_proof() {
        let words = [2usize, 42, 43];
        assert_eq!(decode(&words, size_of_val(&words), 42).ok(), Some(true));
        assert_eq!(decode(&words, size_of_val(&words), 44).ok(), Some(false));
        for bytes in [0, OFFSET - 1, OFFSET, OFFSET + size_of::<usize>(), 1000] {
            assert!(decode(&words, bytes, 42).is_err());
        }
        assert!(decode(&[MAX_IDS + 1, 42], 2 * size_of::<usize>(), 42).is_err());
        assert!(decode(&[1, 0], 2 * size_of::<usize>(), 42).is_err());
    }

    #[test]
    fn unsupported_and_partial_queries_cannot_admit_a_surviving_pid() {
        let words = [1usize, 42];
        for status in [
            STATUS_INVALID_INFO_CLASS,
            STATUS_NOT_SUPPORTED,
            STATUS_ACCESS_DENIED,
        ] {
            assert!(response(status, STATUS_SUCCESS, &words, size_of_val(&words), 42).is_err());
        }
        assert!(
            response(
                STATUS_SUCCESS,
                STATUS_PENDING,
                &words,
                size_of_val(&words),
                42
            )
            .is_err()
        );
        assert_eq!(
            response(
                STATUS_BUFFER_OVERFLOW,
                STATUS_SUCCESS,
                &words,
                size_of_val(&words),
                42
            )
            .ok(),
            Some(None)
        );
    }
}
