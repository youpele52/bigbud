//! Time Machine exclusion for the host state root (plan §8.3). The sticky exclusion is the
//! `com.apple.metadata:com_apple_backup_excludeItem` xattr holding a binary plist of the string
//! `com.apple.backupd`, exactly what `tmutil addexclusion` writes.

/// How the exclusion was applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupExclusion {
    /// The xattr was written and read back intact.
    Xattr,
    /// Setting the xattr failed; `tmutil addexclusion` succeeded and `tmutil isexcluded`
    /// confirmed it. `xattr_error` is the original failure, for the host log.
    Tmutil { xattr_error: String },
}

/// `bplist00`, one ASCII string object (`0x5F 0x10 0x11` = string, length 17), a one-entry
/// offset table and the 32-byte trailer (1-byte offsets and refs, 1 object, top 0, table at 28).
pub const BACKUP_EXCLUDE_PLIST: [u8; 61] = [
    b'b', b'p', b'l', b'i', b's', b't', b'0', b'0', 0x5F, 0x10, 0x11, b'c', b'o', b'm', b'.', b'a',
    b'p', b'p', b'l', b'e', b'.', b'b', b'a', b'c', b'k', b'u', b'p', b'd', 0x08, 0, 0, 0, 0, 0, 0,
    1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x1C,
];

pub const BACKUP_EXCLUDE_XATTR: &str = "com.apple.metadata:com_apple_backup_excludeItem";

#[cfg(target_os = "macos")]
pub use macos::{exclude_from_backup, is_excluded_from_backup, read_backup_xattr};

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::process::{Command, Stdio};

    use super::{BACKUP_EXCLUDE_PLIST, BACKUP_EXCLUDE_XATTR, BackupExclusion};
    use crate::terminal_spool::errors::SpoolError;

    const TMUTIL: &str = "/usr/bin/tmutil";

    fn c_path(path: &Path) -> Result<CString, SpoolError> {
        CString::new(path.as_os_str().as_bytes()).map_err(|_| SpoolError::InvalidArgument("path"))
    }

    fn c_name() -> Result<CString, SpoolError> {
        CString::new(BACKUP_EXCLUDE_XATTR).map_err(|_| SpoolError::InvalidArgument("xattr"))
    }

    /// Excludes `root` from Time Machine: the xattr first, then `tmutil addexclusion`.
    pub fn exclude_from_backup(root: &Path) -> Result<BackupExclusion, SpoolError> {
        let xattr_error = match set_xattr(root) {
            Ok(()) if read_backup_xattr(root)?.as_deref() == Some(&BACKUP_EXCLUDE_PLIST[..]) => {
                return Ok(BackupExclusion::Xattr);
            }
            Ok(()) => "xattr did not read back intact".to_owned(),
            Err(error) => error.to_string(),
        };
        let output = run_tmutil(&["addexclusion"], root)?;
        eprintln!(
            "bigbud terminal spool: backup xattr failed ({xattr_error}); tmutil addexclusion {}",
            if output.status.success() {
                "succeeded"
            } else {
                "failed"
            }
        );
        if !output.status.success() {
            return Err(SpoolError::Io(io::Error::other(format!(
                "tmutil addexclusion exited with {}",
                output.status
            ))));
        }
        if !is_excluded_from_backup(root)? {
            return Err(SpoolError::Io(io::Error::other(
                "tmutil isexcluded does not report the exclusion",
            )));
        }
        Ok(BackupExclusion::Tmutil { xattr_error })
    }

    fn set_xattr(root: &Path) -> Result<(), SpoolError> {
        let path = c_path(root)?;
        let name = c_name()?;
        // SAFETY: both strings are NUL-terminated and live across the call; the value pointer
        // and length describe the constant plist; position 0 and no flags is a plain set.
        let result = unsafe {
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                BACKUP_EXCLUDE_PLIST.as_ptr().cast(),
                BACKUP_EXCLUDE_PLIST.len(),
                0,
                0,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(SpoolError::Io(io::Error::last_os_error()))
        }
    }

    /// Reads the exclusion xattr, `None` when absent.
    pub fn read_backup_xattr(root: &Path) -> Result<Option<Vec<u8>>, SpoolError> {
        let path = c_path(root)?;
        let name = c_name()?;
        let mut buffer = [0u8; 256];
        // SAFETY: valid NUL-terminated strings; the buffer pointer and length describe a live
        // stack array the kernel writes at most `len` bytes into.
        let read = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                0,
                0,
            )
        };
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOATTR) {
                return Ok(None);
            }
            return Err(SpoolError::Io(error));
        }
        let length = usize::try_from(read).map_err(|_| SpoolError::Corrupt)?;
        Ok(buffer.get(..length).map(<[u8]>::to_vec))
    }

    /// `tmutil isexcluded <path>` prints `[Excluded]` for an excluded item.
    pub fn is_excluded_from_backup(root: &Path) -> Result<bool, SpoolError> {
        let output = run_tmutil(&["isexcluded"], root)?;
        if !output.status.success() {
            return Err(SpoolError::Io(io::Error::other(format!(
                "tmutil isexcluded exited with {}",
                output.status
            ))));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.trim_start().starts_with("[Excluded]")))
    }

    fn run_tmutil(args: &[&str], root: &Path) -> Result<std::process::Output, SpoolError> {
        let child = {
            let _gate = crate::spawn_gate::lock()?;
            Command::new(TMUTIL)
                .args(args)
                .arg(root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?
        };
        Ok(child.wait_with_output()?)
    }
}
