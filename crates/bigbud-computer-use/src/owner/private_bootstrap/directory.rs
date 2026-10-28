//! Transient endpoint storage, NOT the durable cross-profile election root.
//! Security boundary: other UIDs, not hostile root or arbitrary same-UID code.
use super::{acl, io::invalid};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io,
    os::fd::AsRawFd,
    path::PathBuf,
};

pub(super) use crate::native_fs::descriptor::{named, open_at, same_named, stat};

pub(super) const SOCKET: &CStr = c"peer";

pub(super) struct Directory {
    ancestors: [File; 3],
    pub(super) file: File,
    name: CString,
    pub(super) nonce: [u8; 16],
    removed: bool,
}
impl Directory {
    pub(super) fn create() -> io::Result<Self> {
        // Fixed, non-environment root; every lookup is no-follow and dirfd-relative.
        let root = open_at(libc::AT_FDCWD, c"/")?;
        let private = open_at(root.as_raw_fd(), c"private")?;
        let tmp = open_at(private.as_raw_fd(), c"tmp")?;
        let ancestors = [root, private, tmp];
        validate_ancestors(&ancestors)?;
        let mut nonce = [0; 16];
        // SAFETY: exactly 16 writable bytes; getentropy is bounded and uses the
        // kernel RNG, not time/PID/path secrecy as authentication authority.
        if unsafe { libc::getentropy(nonce.as_mut_ptr().cast(), nonce.len()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let name = name(&nonce)?;
        // SAFETY: live parent fd and a single fixed-format NUL-terminated name.
        // mkdirat is exclusive; collisions refuse, never adopt an existing leaf.
        if unsafe { libc::mkdirat(ancestors[2].as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // If opening fails we cannot establish ownership: deliberately leave the
        // ambiguous name, never blindly unlink a pathname on a failure path.
        let file = open_at(ancestors[2].as_raw_fd(), &name)?;
        let result = Self {
            ancestors,
            file,
            name,
            nonce,
            removed: false,
        };
        result.validate()?;
        Ok(result)
    }

    pub(super) fn path(&self) -> io::Result<PathBuf> {
        endpoint_path(&self.nonce)
    }

    pub(super) fn validate(&self) -> io::Result<()> {
        if self.removed {
            return Err(invalid());
        }
        validate_ancestors(&self.ancestors)?;
        check_directory(&self.file, effective_uid(), 0o700)?;
        same_named(&self.ancestors[0], c"private", &stat(&self.ancestors[1])?)?;
        same_named(&self.ancestors[1], c"tmp", &stat(&self.ancestors[2])?)?;
        same_named(&self.ancestors[2], &self.name, &stat(&self.file)?)
    }

    pub(super) fn cleanup(&mut self) -> io::Result<()> {
        if self.removed {
            return Ok(());
        }
        self.validate()?;
        // SAFETY: held validated parent and name still matching the owned inode.
        // No recursive deletion; nonempty/changed directories are left in place.
        if unsafe {
            libc::unlinkat(
                self.ancestors[2].as_raw_fd(),
                self.name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        self.removed = true;
        Ok(())
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        // Best-effort only: validation failure/ambiguity preserves the resource.
        // Explicit endpoint cleanup reports errors before returning a connection.
        let _preserve_on_failure = self.cleanup();
    }
}

fn validate_ancestors(files: &[File; 3]) -> io::Result<()> {
    check_directory(&files[0], 0, 0o755)?;
    check_directory(&files[1], 0, 0o755)?;
    check_directory(&files[2], 0, 0o1777)
}

pub(super) fn effective_uid() -> u32 {
    // SAFETY: no arguments, no failure result.
    unsafe { libc::geteuid() }
}

pub(super) fn check_directory(file: &File, uid: u32, mode: u16) -> io::Result<()> {
    let metadata = stat(file)?;
    if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR
        || metadata.st_uid != uid
        || metadata.st_mode & 0o7777 != mode
    {
        return Err(invalid());
    }
    acl::require_empty(file)
}

fn name(nonce: &[u8; 16]) -> io::Result<CString> {
    let hex: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    CString::new(format!("bbcu-{hex}")).map_err(|_| invalid())
}

pub(super) fn endpoint_path(nonce: &[u8; 16]) -> io::Result<PathBuf> {
    let name = name(nonce)?;
    Ok(PathBuf::from("/private/tmp")
        .join(name.to_str().map_err(|_| invalid())?)
        .join("peer"))
}
