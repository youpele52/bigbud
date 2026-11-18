use std::io;
use std::os::fd::RawFd;

/// `STATX_MNT_ID` from the stable Linux UAPI (`include/uapi/linux/stat.h`).
const STATX_MNT_ID: u32 = 0x0000_1000;

/// Kernel `struct statx` (UAPI, 256 bytes). Only the request mask and the mount ID are read;
/// the remaining fields are kept as opaque padding at their fixed UAPI offsets.
#[repr(C)]
struct RawStatx {
    stx_mask: u32,
    /// `stx_blksize` through `stx_dev_minor` (offsets 4..144).
    _head: [u32; 35],
    stx_mnt_id: u64,
    /// Reserved/extended fields after `stx_mnt_id` (offsets 152..256).
    _tail: [u64; 13],
}

const _: () = assert!(std::mem::size_of::<RawStatx>() == 256);
const _: () = assert!(std::mem::offset_of!(RawStatx, stx_mnt_id) == 144);

pub(super) fn mount_id(fd: RawFd) -> io::Result<u64> {
    let mut stat = RawStatx {
        stx_mask: 0,
        _head: [0; 35],
        stx_mnt_id: 0,
        _tail: [0; 13],
    };
    let empty = c"";
    // SAFETY: SYS_statx takes (dirfd, path, flags, mask, buf). The path is a valid empty C
    // string used with AT_EMPTY_PATH for the caller's live descriptor, and `stat` is a writable
    // buffer whose size and layout match the 256-byte kernel UAPI `struct statx` (asserted above).
    let result = unsafe {
        libc::syscall(
            libc::SYS_statx,
            fd,
            empty.as_ptr(),
            libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
            STATX_MNT_ID,
            std::ptr::from_mut(&mut stat),
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if stat.stx_mask & STATX_MNT_ID == 0 {
        return Err(io::Error::other("unsupported mount identity"));
    }
    Ok(stat.stx_mnt_id)
}

#[cfg(test)]
mod tests {
    use super::mount_id;
    use std::fs::File;
    use std::os::fd::AsRawFd;

    #[test]
    fn reports_one_mount_identity_for_one_filesystem() {
        let directory = std::env::temp_dir().join(format!("bigbud-statx-{}", std::process::id()));
        let ids = std::fs::create_dir_all(&directory).and_then(|()| {
            let first = File::create(directory.join("first"))?;
            let second = File::create(directory.join("second"))?;
            Ok((mount_id(first.as_raw_fd())?, mount_id(second.as_raw_fd())?))
        });
        let cleanup = std::fs::remove_dir_all(&directory);
        assert!(cleanup.is_ok(), "{cleanup:?}");
        assert!(
            matches!(ids, Ok((first, second)) if first == second && first != 0),
            "{ids:?}"
        );
    }

    #[test]
    fn rejects_a_closed_descriptor() {
        assert!(mount_id(-1).is_err());
    }
}
