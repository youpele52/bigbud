use std::{
    fs::{self, Metadata},
    io,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Component, Path, PathBuf},
};

use crate::invalid_input;

pub(super) fn effective_uid() -> libc::uid_t {
    // SAFETY: geteuid has no arguments or caller obligations.
    unsafe { libc::geteuid() }
}

#[cfg(target_os = "macos")]
pub(super) fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: the stream owns a live Unix socket; both outputs are writable.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

#[cfg(target_os = "linux")]
pub(super) fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: the socket is live and both outputs point to correctly sized writable storage.
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut size,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if size as usize != std::mem::size_of::<libc::ucred>() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid peer credentials",
        ));
    }
    // SAFETY: a successful call with this size initialized the full ucred.
    Ok(unsafe { credentials.assume_init() }.uid)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn peer_uid(_: &UnixStream) -> io::Result<libc::uid_t> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "peer credentials unavailable",
    ))
}

#[derive(PartialEq, Eq)]
struct Inode(u64, u64);

impl From<&Metadata> for Inode {
    fn from(metadata: &Metadata) -> Self {
        Self(metadata.dev(), metadata.ino())
    }
}

pub(super) struct OwnedSocket {
    path: PathBuf,
    parent: Inode,
    inode: Inode,
    uid: libc::uid_t,
}

impl OwnedSocket {
    pub(super) fn bind(path: &Path, uid: libc::uid_t) -> io::Result<(Self, UnixListener)> {
        if !cfg!(any(target_os = "macos", target_os = "linux")) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "attachment unavailable",
            ));
        }
        let parent = path.parent().ok_or_else(invalid_input)?;
        let name = path.file_name().ok_or_else(invalid_input)?;
        if !path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            || path.as_os_str() != parent.join(name).as_os_str()
        {
            return Err(invalid_input());
        }
        let parent_metadata = fs::symlink_metadata(parent)?;
        if !private_directory(&parent_metadata, uid) {
            return Err(invalid_input());
        }
        // Accept system aliases such as /tmp on macOS, but bind and clean up
        // only through the validated canonical hierarchy.
        let canonical_parent = fs::canonicalize(parent)?;
        for ancestor in canonical_parent.ancestors() {
            let metadata = fs::symlink_metadata(ancestor)?;
            if !metadata.is_dir()
                || (metadata.uid() != uid && metadata.uid() != 0)
                || (metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0)
            {
                return Err(invalid_input());
            }
        }
        let canonical_metadata = fs::symlink_metadata(&canonical_parent)?;
        let parent = Inode::from(&parent_metadata);
        if !private_directory(&canonical_metadata, uid)
            || Inode::from(&canonical_metadata) != parent
        {
            return Err(invalid_input());
        }
        let path = canonical_parent.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
            // An owner ended by a signal (for example SIGTERM at logout) never runs
            // `Drop`, so its socket stays behind and would refuse every later owner.
            // Only this uid's socket inside the verified private directory, with no
            // listener behind it, is stale; anything else still refuses.
            Ok(metadata) if owned_socket(&metadata, uid) && stale_socket(&path) => {
                fs::remove_file(&path)?;
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "attachment path exists",
                ));
            }
        }
        // The parent directory is already verified 0700 and owned by this uid, so it
        // is the access boundary; other users cannot traverse to the socket. Bind
        // normally and tighten the socket's own mode afterwards rather than
        // mutating the process-wide umask, which would race other threads.
        let listener = UnixListener::bind(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let metadata = fs::symlink_metadata(&path)?;
        if !owned_socket(&metadata, uid) {
            return Err(invalid_input());
        }
        let socket = Self {
            path,
            parent,
            inode: Inode::from(&metadata),
            uid,
        };
        if metadata.mode() & 0o777 != 0o600 {
            return Err(invalid_input());
        }
        Ok((socket, listener))
    }
}

fn private_directory(metadata: &Metadata, uid: libc::uid_t) -> bool {
    metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o777 == 0o700
}

fn owned_socket(metadata: &Metadata, uid: libc::uid_t) -> bool {
    metadata.file_type().is_socket() && metadata.uid() == uid
}

/// A socket path is stale only when connecting is refused: no process listens on it.
fn stale_socket(path: &Path) -> bool {
    matches!(
        UnixStream::connect(path),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused
    )
}

impl Drop for OwnedSocket {
    fn drop(&mut self) {
        let Some(parent) = self.path.parent() else {
            return;
        };
        if let Ok(metadata) = fs::symlink_metadata(parent)
            && private_directory(&metadata, self.uid)
            && Inode::from(&metadata) == self.parent
            && let Ok(metadata) = fs::symlink_metadata(&self.path)
            && owned_socket(&metadata, self.uid)
            && Inode::from(&metadata) == self.inode
        {
            // Best effort: never retry unlink after an error or a replacement.
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
#[path = "socket_tests.rs"]
mod tests;
