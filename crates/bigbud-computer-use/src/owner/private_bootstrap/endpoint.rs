//! Private pathname listener under a verified root-owned sticky temp parent.
//! No protection against hostile root/same-UID pathname mutation is claimed.
//! Held descriptors + inode checks protect cleanup from observed replacement;
//! permission/ACL policy, not those checks, excludes other-UID substitution.
use super::{
    directory::{Directory, SOCKET, effective_uid, named, same_named},
    io::{invalid, remaining, retry, wait},
};
use std::{
    io,
    os::{
        fd::AsRawFd,
        unix::net::{UnixListener, UnixStream},
    },
    time::Instant,
};

pub(super) struct Endpoint {
    pub(super) directory: Directory,
    listener: Option<UnixListener>,
    socket: Option<libc::stat>,
}
impl Endpoint {
    pub(super) fn create(deadline: Instant) -> io::Result<Self> {
        remaining(deadline)?;
        Self::bind(Directory::create()?, deadline)
    }

    pub(super) fn bind(directory: Directory, deadline: Instant) -> io::Result<Self> {
        remaining(deadline)?;
        let mut result = Self {
            directory,
            listener: None,
            socket: None,
        };
        result.directory.validate()?;
        // No global cwd/umask mutation. The verified 0700 no-ACL leaf excludes
        // other UIDs even before socket permissions are tightened below.
        result.listener = Some(UnixListener::bind(result.directory.path()?)?);
        crate::owner::unix_peer::ensure_private_fd(result.listener.as_ref().ok_or_else(invalid)?)?;
        let metadata = named(&result.directory.file, SOCKET)?;
        if metadata.st_mode & libc::S_IFMT != libc::S_IFSOCK
            || metadata.st_uid != effective_uid()
            || metadata.st_nlink != 1
        {
            return Err(invalid());
        }
        result.socket = Some(metadata);
        // SAFETY: held private directory, fixed owned socket name; do not follow
        // a symlink. Other-UID replacement is excluded by the directory policy.
        if unsafe {
            libc::fchmodat(
                result.directory.file.as_raw_fd(),
                SOCKET.as_ptr(),
                0o600,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut expected = metadata;
        expected.st_mode = libc::S_IFSOCK | 0o600;
        same_named(&result.directory.file, SOCKET, &expected)?;
        result.socket = Some(expected);
        result
            .listener
            .as_ref()
            .ok_or_else(invalid)?
            .set_nonblocking(true)?;
        result.directory.validate()?;
        remaining(deadline)?;
        Ok(result)
    }

    /// Exactly one connection attempt; an invalid peer is not retried. Accepted
    /// stream authentication remains the caller's one-use capability operation.
    pub(super) fn accept(mut self, deadline: Instant) -> io::Result<UnixStream> {
        self.directory.validate()?;
        same_named(
            &self.directory.file,
            SOCKET,
            self.socket.as_ref().ok_or_else(invalid)?,
        )?;
        let listener = self.listener.as_ref().ok_or_else(invalid)?;
        let stream = loop {
            remaining(deadline)?;
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if retry(&error) => wait(listener, libc::POLLIN, deadline)?,
                Err(error) => return Err(error),
            }
        };
        remaining(deadline)?;
        self.cleanup()?;
        remaining(deadline)?;
        Ok(stream)
    }

    pub(super) fn cleanup(&mut self) -> io::Result<()> {
        // Keep the listener alive through the inode check/unlink, retaining its
        // vnode reference rather than opening an avoidable inode-reuse window.
        if let Some(expected) = &self.socket {
            self.directory.validate()?;
            same_named(&self.directory.file, SOCKET, expected)?;
            // SAFETY: retained private directory and fixed owned inode-checked
            // name; no recursive/absolute cleanup or pre-existing-name removal.
            if unsafe { libc::unlinkat(self.directory.file.as_raw_fd(), SOCKET.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            self.socket = None;
        }
        drop(self.listener.take());
        // Directory drop removes the empty owned leaf. Missing/replaced names
        // refuse; no cleanup success is inferred from an ambiguous lookup.
        self.directory.cleanup()
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        // No panic or success claim on cleanup failure. Ambiguous resources stay
        // behind; callers use explicit cleanup when a result must be delivered.
        let _preserve_on_failure = self.cleanup();
    }
}
