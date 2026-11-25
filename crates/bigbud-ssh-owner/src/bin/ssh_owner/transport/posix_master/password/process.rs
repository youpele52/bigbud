//! Kernel-backed PID/parent/executable checks for the one-shot exchange.
use super::super::{SSH, UNAVAILABLE, paths};
use crate::v1::ErrorCode;
use std::{
    fs::{self, Metadata},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Image {
    dev: u64,
    ino: u64,
}

impl Image {
    pub(super) fn at(path: &Path) -> Result<Self, ErrorCode> {
        let metadata = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
        if !metadata.is_file() || metadata.mode() & 0o6022 != 0 || metadata.mode() & 0o111 == 0 {
            return Err(UNAVAILABLE);
        }
        Ok(Self::of(&metadata))
    }

    fn of(metadata: &Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        }
    }

    pub(super) fn running(pid: u32) -> Result<Self, ErrorCode> {
        #[cfg(target_os = "linux")]
        {
            // Unlike checking a string from readlink, this stats the inode of
            // the executable held by the kernel even if its name is replaced.
            let meta = fs::metadata(format!("/proc/{pid}/exe")).map_err(|_| UNAVAILABLE)?;
            Ok(Self::of(&meta))
        }
        #[cfg(target_os = "macos")]
        Self::at(&executable_path(pid)?)
    }
}

pub(super) fn helper_image() -> Result<(PathBuf, Image), ErrorCode> {
    let path = std::env::current_exe().map_err(|_| UNAVAILABLE)?;
    let image = Image::running(std::process::id())?;
    if !path.is_absolute() || Image::at(&path)? != image {
        return Err(UNAVAILABLE);
    }
    Ok((path, image))
}

pub(super) fn verify_helper(pid: u32, ssh: u32, image: Image) -> Result<(), ErrorCode> {
    if parent(pid)? != ssh || Image::running(pid)? != image {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

pub(super) fn verify_ssh(pid: u32, owner: u32) -> Result<(), ErrorCode> {
    if parent(pid)? != owner || Image::running(pid)? != Image::at(Path::new(SSH))? {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn parent(pid: u32) -> Result<u32, ErrorCode> {
    use std::io::Read;
    let file = fs::File::open(format!("/proc/{pid}/stat")).map_err(|_| UNAVAILABLE)?;
    if file.metadata().map_err(|_| UNAVAILABLE)?.uid() != paths::uid() {
        return Err(UNAVAILABLE);
    }
    let mut stat = Vec::new();
    file.take(4097)
        .read_to_end(&mut stat)
        .map_err(|_| UNAVAILABLE)?;
    if stat.len() > 4096 {
        return Err(UNAVAILABLE);
    }
    // The process name is parenthesized and may contain spaces, ')' or bytes
    // outside UTF-8. The state and PPID follow its final ')'.
    let end = stat
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or(UNAVAILABLE)?;
    let fields = stat.get(end + 1..).ok_or(UNAVAILABLE)?;
    std::str::from_utf8(fields)
        .map_err(|_| UNAVAILABLE)?
        .split_ascii_whitespace()
        .nth(1)
        .and_then(|ppid| ppid.parse().ok())
        .ok_or(UNAVAILABLE)
}

#[cfg(target_os = "macos")]
fn parent(pid: u32) -> Result<u32, ErrorCode> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let len = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: PROC_PIDTBSDINFO writes at most len bytes to the matching struct.
    let read = unsafe {
        libc::proc_pidinfo(
            pid.try_into().map_err(|_| UNAVAILABLE)?,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            len,
        )
    };
    if read != len {
        return Err(UNAVAILABLE);
    }
    // SAFETY: a full-sized response initializes the fixed C record.
    let info = unsafe { info.assume_init() };
    if info.pbi_uid != paths::uid() || info.pbi_pid != pid {
        return Err(UNAVAILABLE);
    }
    Ok(info.pbi_ppid)
}

#[cfg(target_os = "macos")]
fn executable_path(pid: u32) -> Result<PathBuf, ErrorCode> {
    use std::os::unix::ffi::OsStrExt;
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the output buffer is writable and its capacity is passed.
    let read = unsafe {
        libc::proc_pidpath(
            pid.try_into().map_err(|_| UNAVAILABLE)?,
            path.as_mut_ptr().cast(),
            path.len() as u32,
        )
    };
    if read <= 0 {
        return Err(UNAVAILABLE);
    }
    let end = path.iter().position(|byte| *byte == 0).ok_or(UNAVAILABLE)?;
    let bytes = path.get(..end).ok_or(UNAVAILABLE)?;
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}
