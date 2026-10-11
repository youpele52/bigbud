//! Qualification-only metadata experiment. Never called by production inspection/admission.
use super::{file, security};
use std::{
    fs::File,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*, System::Threading::*};
#[path = "windows.metadata.maps.rs"]
mod maps;
#[path = "windows.metadata.members.rs"]
mod members;

/// Observed physical IDs, not an authorization or production admission result.
#[derive(Debug)]
pub struct Observation {
    pub birth: String,
    pub path: String,
    pub identity: String,
    pub shm_identity: String,
}

struct Process {
    handle: OwnedHandle,
    pid: u32,
    birth: String,
}
impl Process {
    fn open(pid: u32) -> io::Result<Self> {
        if pid == 0 {
            return Err(io::Error::other("invalid pid"));
        }
        // SAFETY: query-only, no VM_READ, duplication, synchronization, suspension or mutation rights.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful OpenProcess transfers exactly one handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        if !security::current_user()?.same(&security::process_user(raw)?) {
            return Err(io::Error::other("process owner mismatch"));
        }
        let birth = Self::stamp(raw)?;
        Ok(Self { handle, pid, birth })
    }
    fn stamp(raw: HANDLE) -> io::Result<String> {
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let mut code = 0;
        // SAFETY: retained process handle and initialized outputs; no process state changes.
        if unsafe { GetProcessTimes(raw, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
            || unsafe { GetExitCodeProcess(raw, &mut code) } == 0
            || code != STILL_ACTIVE as u32
        {
            return Err(io::Error::other("process unavailable"));
        }
        Ok(format!(
            "{:08x}{:08x}",
            creation.dwHighDateTime, creation.dwLowDateTime
        ))
    }
    fn recheck(&self) -> io::Result<()> {
        if Self::stamp(self.handle.as_raw_handle())? != self.birth {
            return Err(io::Error::other("process birth changed"));
        }
        Ok(())
    }
}

fn ntfs(file: &File) -> io::Result<()> {
    let mut name = [0u16; 32];
    // SAFETY: independently opened local file, bounded filesystem-name output; metadata only.
    if unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if name[..5] != [78, 84, 70, 83, 0] {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "prototype requires local NTFS",
        ));
    }
    Ok(())
}

fn measured(process: &Process, path: &str, private: bool) -> io::Result<(File, String)> {
    let local = file::open_checked(path, false, private)?;
    ntfs(&local)?;
    let identity = file::identity(&local)?;
    if !members::contains(&local, process.pid)? {
        return Err(io::Error::other("class47 target membership absent"));
    }
    if identity != file::identity(&local)? {
        return Err(io::Error::other("measured file identity changed"));
    }
    process.recheck()?;
    Ok((local, identity))
}

/// Investigate class-47 membership on a known fixture pathname, without treating its path as identity.
pub fn membership(pid: u32, path: &str) -> io::Result<(bool, String)> {
    let process = Process::open(pid)?;
    let local = file::open_checked(path, false, false)?;
    ntfs(&local)?;
    let identity = file::identity(&local)?;
    let member = members::contains(&local, pid)?;
    process.recheck()?;
    if identity != file::identity(&local)? {
        return Err(io::Error::other("membership identity changed"));
    }
    Ok((member, identity))
}

/// Investigate mapped SHM nomination plus same-handle physical identity and target membership.
pub fn probe(pid: u32) -> io::Result<Observation> {
    probe_with(pid, || Ok(()))
}

/// Qualification hook between observations, allowing deterministic fixture mapping/replacement races.
pub fn probe_with(pid: u32, between: impl FnOnce() -> io::Result<()>) -> io::Result<Observation> {
    let process = Process::open(pid)?;
    let before = maps::scan(process.handle.as_raw_handle())?;
    if before.len() != 1 {
        return Err(io::Error::other("mapped SHM inventory absent or ambiguous"));
    }
    let mapping = before
        .first()
        .ok_or_else(|| io::Error::other("mapped SHM absent"))?;
    let path = mapping
        .path
        .strip_suffix("-shm")
        .ok_or_else(|| io::Error::other("SHM suffix unavailable"))?;
    let (db, identity) = measured(&process, path, true)?;
    let (shm, shm_identity) = measured(&process, &mapping.path, true)?;
    between()?;
    let after = maps::scan(process.handle.as_raw_handle())?;
    if after != before {
        return Err(io::Error::other("mapping inventory changed"));
    }
    // Retain the first filesystem handles while reopening checked paths and checking membership again.
    let (_, db_again) = measured(&process, path, true)?;
    let (_, shm_again) = measured(&process, &mapping.path, true)?;
    if db_again != identity
        || shm_again != shm_identity
        || file::identity(&db)? != identity
        || file::identity(&shm)? != shm_identity
    {
        return Err(io::Error::other("candidate path replaced"));
    }
    if !members::contains(&db, pid)? || !members::contains(&shm, pid)? {
        return Err(io::Error::other("target membership changed"));
    }
    process.recheck()?;
    Ok(Observation {
        birth: process.birth,
        path: file::name(&db)?,
        identity,
        shm_identity,
    })
}
