//! Shared Windows evidence for an immutable, ordinary local file path.
use std::{
    fs::{File, OpenOptions},
    io,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, GetDriveTypeW,
    GetFileInformationByHandle, GetFinalPathNameByHandleW,
};

const MAX_PATH: usize = 230;
const DRIVE_FIXED: u32 = 3;

#[doc(hidden)]
pub struct GuardedLocalPath(String);

impl GuardedLocalPath {
    pub fn new(path: &Path) -> io::Result<Self> {
        let path = path.to_str().ok_or_else(invalid_path)?.replace('\\', "/");
        let [drive, b':', b'/', ..] = path.as_bytes() else {
            return Err(invalid_path());
        };
        if !drive.is_ascii_alphabetic()
            || path.len() > MAX_PATH
            || !path
                .get(3..)
                .is_some_and(|rest| rest.split('/').all(valid_component))
        {
            return Err(invalid_path());
        }
        Ok(Self(path))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn open(&self, write: bool) -> io::Result<GuardedLocalFile> {
        let (root, tail) = self.0.split_at(3);
        let root_wide: Vec<u16> = root
            .replace('/', "\\")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // SAFETY: root_wide is NUL terminated and remains live for the call.
        if unsafe { GetDriveTypeW(root_wide.as_ptr()) } != DRIVE_FIXED {
            return Err(invalid_path());
        }
        let mut dirs = Vec::new();
        let mut path = PathBuf::from(root);
        let mut components = tail.split('/').peekable();
        while let Some(part) = components.next() {
            path.push(part);
            if components.peek().is_none() {
                break;
            }
            let directory = open_options()
                .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(&path)?;
            check_handle(&directory, true)?;
            dirs.push(directory);
        }
        let file = open_options()
            .read(true)
            .write(write)
            // Hold the exact file and all ancestors open without delete sharing.
            // Deny writers throughout the separate scan and SSH handshake.
            .share_mode(if write { 0 } else { FILE_SHARE_READ })
            .open(&path)?;
        check_handle(&file, false)?;
        let dos = resolved_path(&file, &self.0)?;
        Ok(GuardedLocalFile {
            file,
            _dirs: dirs,
            dos,
        })
    }
}

fn valid_component(component: &str) -> bool {
    if component.is_empty()
        || component.starts_with(' ')
        || component.ends_with([' ', '.'])
        || !component
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b' '))
    {
        return false;
    }
    let stem = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .trim_end()
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "AUX" | "CON" | "NUL" | "PRN")
        && !matches!(
            stem.as_bytes(),
            [b'C', b'O', b'M', b'0'..=b'9'] | [b'L', b'P', b'T', b'0'..=b'9']
        )
}

fn open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    options
}

fn check_handle(file: &File, directory: bool) -> io::Result<()> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is live, and info points to writable native storage.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(invalid_path());
    }
    Ok(())
}

fn resolved_path(file: &File, expected: &str) -> io::Result<PathBuf> {
    let mut buffer = [0u16; 260];
    // SAFETY: the handle is live and buffer has the supplied writable length.
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    let found = buffer
        .get(..size)
        .filter(|_| size > 0 && size < buffer.len())
        .and_then(|wide| String::from_utf16(wide).ok())
        .ok_or_else(invalid_path)?;
    // Don't admit redirected drives, UNC, aliases, network paths or device paths.
    found
        .strip_prefix(r"\\?\")
        .filter(|path| path.replace('\\', "/").eq_ignore_ascii_case(expected))
        .map(PathBuf::from)
        .ok_or_else(invalid_path)
}

fn invalid_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "not an ordinary local fixture path",
    )
}

#[doc(hidden)]
pub struct GuardedLocalFile {
    file: File,
    _dirs: Vec<File>,
    dos: PathBuf,
}

impl GuardedLocalFile {
    pub fn file_mut(&mut self) -> &mut File {
        &mut self.file
    }

    pub(super) fn dos_path(&self) -> &Path {
        &self.dos
    }
}
