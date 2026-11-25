use super::{ErrorCode, UNAVAILABLE};
use std::ffi::{CStr, OsStr};
use std::fs::{self, Metadata};
use std::io::ErrorKind;
use std::os::unix::{
    ffi::{OsStrExt, OsStringExt},
    fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
};
use std::path::{Path, PathBuf};

const DIRECTORY_TEMPLATE: &str = "bbcm-XXXXXXXXXXXX";
// OpenSSH binds a temporary name with '.' and 16 random characters before
// publishing the final socket. Leave room for both that suffix and the NUL.
const OPENSSH_TEMP_SUFFIX: usize = 17;
#[cfg(target_os = "macos")]
const SUN_PATH_CAP: usize = 104;
#[cfg(target_os = "linux")]
const SUN_PATH_CAP: usize = 108;

pub(super) struct PrivatePaths {
    directory: PathBuf,
    directory_id: (u64, u64),
    fixture_id: Option<(u64, u64)>,
    pub(super) socket: PathBuf,
}

impl PrivatePaths {
    #[cfg(test)]
    pub(super) fn new() -> Result<Self, ErrorCode> {
        #[cfg(target_os = "macos")]
        let root = Path::new("/private/tmp");
        #[cfg(target_os = "linux")]
        let root = Path::new("/tmp");
        Self::allocate(root, None)
    }

    pub(super) fn new_in(root: &Path) -> Result<Self, ErrorCode> {
        require_no_residual_lease(root)?;
        Self::allocate(root, Some(file_id(&private_dir(root)?)))
    }

    #[cfg(target_os = "linux")]
    pub(super) fn new_in_route(root: &Path) -> Result<Self, ErrorCode> {
        // Only the fenced fixture route calls this after an initial residual
        // scan, while holding the exclusive profile lock for this root.
        linux_fixture_parent(root.parent().ok_or(UNAVAILABLE)?)?;
        Self::allocate(root, Some(file_id(&private_dir(root)?)))
    }

    fn allocate(root: &Path, fixture_id: Option<(u64, u64)>) -> Result<Self, ErrorCode> {
        check_parent(root, fixture_id)?;
        let directory_template = root.join(DIRECTORY_TEMPLATE);
        if directory_template.join("s").as_os_str().as_bytes().len() + OPENSSH_TEMP_SUFFIX
            >= SUN_PATH_CAP
        {
            return Err(UNAVAILABLE);
        }
        let mut template = directory_template.into_os_string().into_vec();
        if template.contains(&0) {
            return Err(UNAVAILABLE);
        }
        template.push(0);
        // SAFETY: mkdtemp mutates only the supplied writable NUL-terminated
        // template; on success this is a new directory created with mode 0700.
        if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() {
            return Err(UNAVAILABLE);
        }
        let name = CStr::from_bytes_with_nul(&template).map_err(|_| UNAVAILABLE)?;
        let directory = PathBuf::from(OsStr::from_bytes(name.to_bytes()));
        check_parent(root, fixture_id)?;
        let meta = private_dir(&directory)?;
        if let Some(id) = fixture_id {
            // Keep the directory entry across owner loss before we are allowed
            // to start a child. If sync fails the remaining entry blocks restart.
            sync_fixture(root, id)?;
        }
        let socket = directory.join("s");
        Ok(Self {
            directory,
            directory_id: file_id(&meta),
            fixture_id,
            socket,
        })
    }

    pub(super) fn require_fixture_fence(&self) -> Result<(), ErrorCode> {
        self.fixture_id.ok_or(UNAVAILABLE)?;
        self.check_directory()
    }

    fn check_directory(&self) -> Result<(), ErrorCode> {
        check_parent(self.directory.parent().ok_or(UNAVAILABLE)?, self.fixture_id)?;
        if file_id(&private_dir(&self.directory)?) != self.directory_id {
            return Err(UNAVAILABLE);
        }
        Ok(())
    }

    #[cfg(any(test, target_os = "linux"))]
    pub(super) fn askpass_path(&self) -> Result<PathBuf, ErrorCode> {
        self.check_directory()?;
        Ok(self.directory.join("a"))
    }

    pub(super) fn observe(&self) -> Result<Option<Stamp>, ErrorCode> {
        self.check_directory()?;
        match fs::symlink_metadata(&self.socket) {
            Ok(meta)
                if meta.file_type().is_socket()
                    && meta.uid() == uid()
                    && meta.mode() & 0o7777 == 0o600 =>
            {
                match meta.nlink() {
                    1 => Ok(Some(Stamp::of(&meta))),
                    // OpenSSH publishes by linking a temporary socket and then
                    // removing the temporary name. Do not use it mid-publish.
                    2 => Ok(None),
                    _ => Err(UNAVAILABLE),
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            _ => Err(UNAVAILABLE),
        }
    }

    pub(super) fn remove(&self, socket: Option<Stamp>) -> Result<(), ErrorCode> {
        // Only called after verified reap. Do not signal via the mux or unlink
        // foreign/replaced nodes. Never recurse into an uncertain directory.
        if let Some(found) = self.observe()? {
            if socket != Some(found) {
                return Err(UNAVAILABLE);
            }
            fs::remove_file(&self.socket).map_err(|_| UNAVAILABLE)?;
        }
        self.check_directory()?;
        fs::remove_dir(&self.directory).map_err(|_| UNAVAILABLE)?;
        if let Some(id) = self.fixture_id {
            sync_fixture(self.directory.parent().ok_or(UNAVAILABLE)?, id)?;
        }
        Ok(())
    }
}

pub(super) fn require_no_residual_lease(root: &Path) -> Result<(), ErrorCode> {
    let id = file_id(&private_dir(root)?);
    check_parent(root, Some(id))?;
    scan_no_residual_lease(root)?;
    check_parent(root, Some(id))
}

#[cfg(target_os = "linux")]
pub(super) fn require_no_residual_fixture_entry(root: &Path) -> Result<(), ErrorCode> {
    // A read-only refusal check for a recognized disposable profile. Ordinary
    // fixture startup does not have to remount /tmp to honor a prior fence.
    let id = file_id(&private_dir(root)?);
    scan_no_residual_lease(root)?;
    if file_id(&private_dir(root)?) != id {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

fn scan_no_residual_lease(root: &Path) -> Result<(), ErrorCode> {
    const ENTRY_CAP: usize = 1024;
    for (index, entry) in fs::read_dir(root)
        .map_err(|_| UNAVAILABLE)?
        .take(ENTRY_CAP + 1)
        .enumerate()
    {
        if index == ENTRY_CAP
            || entry
                .map_err(|_| UNAVAILABLE)?
                .file_name()
                .as_bytes()
                .starts_with(b"bbcm-")
        {
            // Residue is unavailable, not evidence that a recorded PID or
            // socket is safe to adopt, signal, connect to or remove.
            return Err(UNAVAILABLE);
        }
    }
    Ok(())
}

fn sync_fixture(root: &Path, id: (u64, u64)) -> Result<(), ErrorCode> {
    check_parent(root, Some(id))?;
    let dir = fs::File::options()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|_| UNAVAILABLE)?;
    if file_id(&dir.metadata().map_err(|_| UNAVAILABLE)?) != id {
        return Err(UNAVAILABLE);
    }
    dir.sync_all().map_err(|_| UNAVAILABLE)
}

fn check_parent(root: &Path, fixture_id: Option<(u64, u64)>) -> Result<(), ErrorCode> {
    if let Some(expected) = fixture_id {
        let parent = root.parent().ok_or(UNAVAILABLE)?;
        #[cfg(target_os = "linux")]
        if linux_fixture_parent(parent).is_ok() {
            return (file_id(&private_dir(root)?) == expected)
                .then_some(())
                .ok_or(UNAVAILABLE);
        }
        trusted_parents(parent, true)?;
        if file_id(&private_dir(root)?) != expected {
            return Err(UNAVAILABLE);
        }
        Ok(())
    } else {
        trusted_parents(root, true)
    }
}

fn private_dir(path: &Path) -> Result<Metadata, ErrorCode> {
    let meta = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    if !meta.is_dir() || meta.uid() != uid() || meta.mode() & 0o7777 != 0o700 {
        return Err(UNAVAILABLE);
    }
    Ok(meta)
}

fn trusted_parents(path: &Path, sticky_leaf: bool) -> Result<(), ErrorCode> {
    let ancestors: Vec<_> = path.ancestors().collect();
    for dir in ancestors.into_iter().rev() {
        let meta = fs::symlink_metadata(dir).map_err(|_| UNAVAILABLE)?;
        let sticky_temp = sticky_leaf && dir == path && meta.mode() & 0o1000 != 0;
        if !meta.is_dir() || meta.uid() != 0 || (meta.mode() & 0o022 != 0 && !sticky_temp) {
            return Err(UNAVAILABLE);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn linux_fixture_parent(path: &Path) -> Result<(), ErrorCode> {
    // Password fixture additionally authenticates the namespace through its
    // bound transport images. These checks enforce the lease path's own safety.
    if path != Path::new("/tmp") || uid() == 0 {
        return Err(UNAVAILABLE);
    }
    for (item, c_path) in [(Path::new("/"), c"/"), (path, c"/tmp")] {
        let meta = fs::symlink_metadata(item).map_err(|_| UNAVAILABLE)?;
        let mut fs = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: c_path is NUL-terminated and fs is writable output storage.
        if !meta.is_dir()
            || meta.uid() != uid()
            || unsafe { libc::statvfs(c_path.as_ptr(), fs.as_mut_ptr()) } != 0
        {
            return Err(UNAVAILABLE);
        }
        // SAFETY: statvfs initialized fs on success.
        if unsafe { fs.assume_init() }.f_flag & libc::ST_RDONLY == 0 {
            return Err(UNAVAILABLE);
        }
    }
    Ok(())
}

pub(super) fn uid() -> u32 {
    // SAFETY: geteuid takes no arguments and observes the current process only.
    unsafe { libc::geteuid() }
}

pub(super) fn executable(path: &Path) -> Result<Stamp, ErrorCode> {
    let invalid = ErrorCode::ConfigUnsupported;
    trusted_parents(path.parent().ok_or(invalid)?, false).map_err(|_| invalid)?;
    let meta = fs::symlink_metadata(path).map_err(|_| invalid)?;
    if !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o6022 != 0 || meta.mode() & 0o111 == 0 {
        return Err(invalid);
    }
    Ok(Stamp::of(&meta))
}

#[cfg(target_os = "linux")]
pub(super) fn bound_executable(path: &Path) -> Result<Stamp, ErrorCode> {
    // Only called after the Transport images have checked the read-only
    // fixture mount with its mapped ownership and bound executable identity.
    let meta = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    Ok(Stamp::of(&meta))
}

fn file_id(meta: &Metadata) -> (u64, u64) {
    (meta.dev(), meta.ino())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Stamp {
    file: (u64, u64),
    changed: (i64, i64),
    modified: (i64, i64),
    len: u64,
    mode: u32,
}

impl Stamp {
    fn of(meta: &Metadata) -> Self {
        Self {
            file: file_id(meta),
            changed: (meta.ctime(), meta.ctime_nsec()),
            modified: (meta.mtime(), meta.mtime_nsec()),
            len: meta.len(),
            mode: meta.mode(),
        }
    }
}
