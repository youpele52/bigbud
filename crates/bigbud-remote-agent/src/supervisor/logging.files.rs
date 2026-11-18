use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

/// Fixed, pinned inodes avoid symlink-following reopens and extra generations.
/// Rotation copies at most one capped file; even a crash leaves <= two caps.
pub(super) struct RotatingLog {
    current: File,
    previous: File,
    limit: u64,
}

impl RotatingLog {
    pub(super) fn open(root: &Path, limit: u64) -> io::Result<Self> {
        if limit == 0 || limit > super::FILE_BYTES {
            return Err(io::Error::other("invalid supervisor log cap"));
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)?;
        private_owner(&directory.metadata()?)?;
        let current = open_log(&directory, c"supervisor.log")?;
        // SAFETY: current owns a valid regular file descriptor. Nonblocking
        // flock prevents a second logger from truncating an active log pair.
        if unsafe { libc::flock(current.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let previous = open_log(&directory, c"supervisor.log.1")?;
        // Validate BOTH before trimming either inherited log. Never chmod,
        // unlink or truncate an unsafe object merely to make startup succeed.
        let mut log = Self {
            current,
            previous,
            limit,
        };
        retain_suffix(&mut log.current, limit)?;
        retain_suffix(&mut log.previous, limit)?;
        Ok(log)
    }

    fn rotate(&mut self) -> io::Result<()> {
        validate_file(&self.current.metadata()?)?;
        validate_file(&self.previous.metadata()?)?;
        self.previous.set_len(0)?;
        self.previous.rewind()?;
        self.current.rewind()?;
        let copied = io::copy(
            &mut (&mut self.current).take(self.limit),
            &mut self.previous,
        )?;
        if copied != self.limit {
            return Err(io::Error::other("supervisor log changed during rotation"));
        }
        self.current.set_len(0)?;
        self.current.rewind()
    }
}

impl Write for RotatingLog {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let metadata = self.current.metadata()?;
        validate_file(&metadata)?;
        // Refuse external mutation rather than growing beyond the bound.
        let mut length = metadata.len();
        if length > self.limit {
            return Err(io::Error::other("supervisor log exceeded its cap"));
        }
        if length == self.limit {
            self.rotate()?;
            length = 0;
        }
        self.current.seek(SeekFrom::Start(length))?;
        let count = bytes.len().min((self.limit - length) as usize);
        let bounded = bytes
            .get(..count)
            .ok_or_else(|| io::Error::other("invalid log write length"))?;
        self.current.write(bounded)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.current.flush()
    }
}

fn private_owner(metadata: &Metadata) -> io::Result<()> {
    // SAFETY: geteuid reads the process account identity and takes no pointers.
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "supervisor logs must be account-private",
        ));
    }
    Ok(())
}

fn validate_file(metadata: &Metadata) -> io::Result<()> {
    private_owner(metadata)?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::other(
            "supervisor log must be a single-link regular file",
        ));
    }
    Ok(())
}

fn open_log(directory: &File, name: &std::ffi::CStr) -> io::Result<File> {
    // SAFETY: directory is pinned and open; name is a fixed, NUL-terminated
    // basename. NOFOLLOW rejects symlinks; NONBLOCK prevents FIFO open hangs.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful openat returned a new exclusively owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    validate_file(&file.metadata()?)?;
    Ok(file)
}

fn retain_suffix(file: &mut File, limit: u64) -> io::Result<()> {
    let length = file.metadata()?.len();
    if length <= limit {
        return Ok(());
    }
    let mut copied = 0;
    let mut buffer = [0; super::CHUNK_BYTES];
    while copied < limit {
        let count = buffer.len().min((limit - copied) as usize);
        let chunk = buffer
            .get_mut(..count)
            .ok_or_else(|| io::Error::other("invalid log suffix length"))?;
        file.seek(SeekFrom::Start(length - limit + copied))?;
        file.read_exact(chunk)?;
        file.seek(SeekFrom::Start(copied))?;
        file.write_all(chunk)?;
        copied += count as u64;
    }
    file.set_len(limit)
}
