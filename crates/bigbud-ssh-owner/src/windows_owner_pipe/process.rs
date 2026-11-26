use super::policy::verify_pid;
use std::{
    ffi::OsString,
    io,
    os::windows::{
        ffi::OsStringExt,
        io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
};
use windows_sys::Win32::{
    Foundation::{
        CompareObjectHandles, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_TIMEOUT,
    },
    Storage::FileSystem::SYNCHRONIZE,
    System::Threading::{
        GetProcessId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW, WaitForSingleObject,
    },
};

// Bound the Win32 DOS-path query, including room for its terminator.
const MAX_IMAGE_CHARS: usize = 32_768;

#[derive(PartialEq, Eq)]
struct ProcessBirth {
    image: OsString,
    creation_time: u64,
}

/// A retained, live process identity from trusted launch/bootstrap state.
/// Do not use a PID learned from the pipe or from an unauthenticated endpoint
/// record to obtain this handle. Capture the peer before using its binding.
pub struct ExpectedPipePeer {
    process: OwnedHandle,
    pid: u32,
    birth: Option<ProcessBirth>,
}

impl ExpectedPipePeer {
    #[cfg(test)]
    pub(super) fn clone_process(&self) -> io::Result<OwnedHandle> {
        self.process.try_clone()
    }

    /// Duplicates a trusted process handle with query and synchronize rights.
    pub fn from_handle(handle: BorrowedHandle<'_>) -> io::Result<Self> {
        let process = handle.try_clone_to_owned()?;
        // SAFETY: process is retained, and the API either identifies it or fails.
        let pid = unsafe { GetProcessId(process.as_raw_handle()) };
        if pid == 0 {
            return Err(io::Error::last_os_error());
        }
        ensure_live(&process)?;
        Ok(Self {
            process,
            pid,
            birth: None,
        })
    }

    /// Pins a directly spawned process from its trusted launch handle and a
    /// separately trusted absolute image path. `image` must use the exact DOS
    /// path spelling returned by Windows; aliases and alternate spellings fail
    /// closed. This checks the loaded process path, not the image's signature,
    /// file contents, parentage, or authorization for any credential role.
    pub fn from_spawned_image(handle: BorrowedHandle<'_>, image: &Path) -> io::Result<Self> {
        if !image.is_absolute() {
            return Err(peer_rejected());
        }
        let mut peer = Self::from_handle(handle)?;
        let birth = process_birth(&peer.process)?;
        if birth.image != image.as_os_str() {
            return Err(peer_rejected());
        }
        ensure_live(&peer.process)?;
        peer.birth = Some(birth);
        Ok(peer)
    }

    /// Rechecks the retained launch binding and the observed process object.
    /// The caller must obtain `observed` from the OS, not accept a claimed PID
    /// or user-supplied handle as evidence. This is a point-in-time check.
    pub fn verify_spawned_process(&self, observed: BorrowedHandle<'_>) -> io::Result<()> {
        same_process(&self.process, observed)?;
        self.verified_birth().map(|_| ())
    }

    /// Checks that Windows records `child` as an immediate child of this
    /// process. Both bindings must already be image-verified. Retain the
    /// trusted parent's launch binding before admitting helpers, and verify
    /// separately that `child` is the actual helper endpoint. This is a
    /// point-in-time lineage check, not proof against deliberate same-user
    /// parent spoofing or authorization for a credential role.
    pub fn verify_immediate_child(&self, child: &Self) -> io::Result<()> {
        if self.pid == child.pid || self.verified_birth()? >= child.verified_birth()? {
            return Err(peer_rejected());
        }
        // Both retained process objects were alive before the snapshot and
        // must still be alive afterward. Neither PID can have been reused in
        // that interval; strict birth order also excludes a newer occupant of
        // a PID retained in the child's historical parent record.
        if parent_snapshot::parent_pid(child.pid)? != self.pid {
            return Err(peer_rejected());
        }
        self.verified_birth()?;
        child.verified_birth()?;
        Ok(())
    }

    /// Pins the inherited owner process object and independently checks the
    /// current helper's immediate parent and grandparent. No process is
    /// opened using a PID taken from the environment or pipe name.
    pub(super) fn askpass_lineage(owner: BorrowedHandle<'_>) -> io::Result<(Self, Self)> {
        // SAFETY: no arguments; Windows supplies the current process ID.
        let current = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() };
        let helper = Self::capture_birth(open_for_query(current)?.as_handle())?;
        let parent_pid = parent_snapshot::parent_pid(current)?;
        let parent = Self::capture_birth(open_for_query(parent_pid)?.as_handle())?;
        let owner = Self::capture_birth(owner)?;
        parent.verify_immediate_child(&helper)?;
        owner.verify_immediate_child(&parent)?;
        Ok((owner, parent))
    }

    fn capture_birth(handle: BorrowedHandle<'_>) -> io::Result<Self> {
        let mut peer = Self::from_handle(handle)?;
        peer.birth = Some(process_birth(&peer.process)?);
        ensure_live(&peer.process)?;
        Ok(peer)
    }

    fn verified_birth(&self) -> io::Result<u64> {
        let birth = self.birth.as_ref().ok_or_else(peer_rejected)?;
        ensure_live(&self.process)?;
        if process_birth(&self.process)? != *birth {
            return Err(peer_rejected());
        }
        ensure_live(&self.process)?;
        Ok(birth.creation_time)
    }

    /// Captures the OS-reported client as a candidate, not as a trusted peer.
    /// The helper endpoint must subsequently verify lineage to its independently
    /// retained SSH child before it may claim any grant.
    pub(super) fn observe_helper(
        query_pid: impl Fn() -> io::Result<u32>,
        image: &Path,
    ) -> io::Result<Self> {
        let process = open_for_query(query_pid()?)?;
        let candidate = Self::from_spawned_image(process.as_handle(), image)?;
        candidate.verify(query_pid)?;
        Ok(candidate)
    }

    pub(super) fn verified_birth_identity(&self) -> io::Result<u128> {
        Ok((u128::from(self.verified_birth()?) << 32) | u128::from(self.pid))
    }

    pub(super) fn verify(&self, query_pid: impl Fn() -> io::Result<u32>) -> io::Result<()> {
        let pid = query_pid()?;
        verify_pid(pid, self.pid, || {
            ensure_live(&self.process)?;
            let observed = open_for_query(pid)?;
            if self.birth.is_some() {
                self.verify_spawned_process(observed.as_handle())?;
            } else {
                same_process(&self.process, observed.as_handle())?;
            }
            let pid = query_pid()?;
            ensure_live(&self.process)?;
            Ok(pid)
        })
    }
}

mod parent_snapshot {
    use super::{HANDLE, owned, peer_rejected};
    use std::{io, os::windows::io::AsRawHandle};
    use windows_sys::{Win32::Foundation::ERROR_NO_MORE_FILES, core::BOOL};

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;

    // PROCESSENTRY32W from tlhelp32.h. Only the two PID fields are evidence;
    // the fixed-size image name is not a substitute for the handle query.
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        pid: u32,
        default_heap_id: usize,
        module_id: u32,
        thread_count: u32,
        parent_pid: u32,
        base_priority: i32,
        flags: u32,
        exe_file: [u16; 260],
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(size_of::<ProcessEntry>() == 568);
    #[cfg(target_pointer_width = "32")]
    const _: () = assert!(size_of::<ProcessEntry>() == 556);

    // These three documented kernel32 imports keep the Windows-only ancestry
    // check local without changing the shared Cargo feature configuration.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> HANDLE;
        fn Process32FirstW(snapshot: HANDLE, entry: *mut ProcessEntry) -> BOOL;
        fn Process32NextW(snapshot: HANDLE, entry: *mut ProcessEntry) -> BOOL;
    }

    pub(super) fn parent_pid(child_pid: u32) -> io::Result<u32> {
        // SAFETY: SNAPPROCESS requests only process records; the pid argument
        // is ignored and the return is a fresh handle or INVALID_HANDLE_VALUE.
        let snapshot = unsafe { owned(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)) }?;
        let mut entry = ProcessEntry {
            size: size_of::<ProcessEntry>() as u32,
            usage: 0,
            pid: 0,
            default_heap_id: 0,
            module_id: 0,
            thread_count: 0,
            parent_pid: 0,
            base_priority: 0,
            flags: 0,
            exe_file: [0; 260],
        };
        // SAFETY: the snapshot remains owned and entry is a correctly sized,
        // writable PROCESSENTRY32W for every call.
        let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.pid == child_pid {
                return if entry.parent_pid == 0 || entry.parent_pid == child_pid {
                    Err(peer_rejected())
                } else {
                    Ok(entry.parent_pid)
                };
            }
            // SAFETY: same retained snapshot and live entry as the first call.
            found = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
            Err(peer_rejected())
        } else {
            Err(error)
        }
    }
}

fn open_for_query(pid: u32) -> io::Result<OwnedHandle> {
    if pid == 0 {
        return Err(peer_rejected());
    }
    // SAFETY: query/synchronize only; OpenProcess returns a fresh handle or null.
    unsafe {
        owned(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            pid,
        ))
    }
}

fn same_process(expected: &OwnedHandle, observed: BorrowedHandle<'_>) -> io::Result<()> {
    // SAFETY: both handles are retained across the comparison.
    if unsafe { CompareObjectHandles(expected.as_raw_handle(), observed.as_raw_handle()) } == 0 {
        return Err(peer_rejected());
    }
    Ok(())
}

fn process_birth(process: &OwnedHandle) -> io::Result<ProcessBirth> {
    let mut image = vec![0u16; MAX_IMAGE_CHARS];
    let mut len = MAX_IMAGE_CHARS as u32;
    // SAFETY: process is retained and len describes the writable UTF-16 buffer.
    // Zero requests DOS path format, not the native device name.
    if unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), 0, image.as_mut_ptr(), &mut len)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let path = image
        .get(..len as usize)
        .filter(|path| !path.is_empty() && path.len() < MAX_IMAGE_CHARS && !path.contains(&0))
        .ok_or_else(peer_rejected)?;
    let [mut creation, mut exit, mut kernel, mut user] = [FILETIME::default(); 4];
    // SAFETY: process is retained and each output points to a distinct FILETIME.
    if unsafe {
        GetProcessTimes(
            process.as_raw_handle(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let creation_time =
        (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if creation_time == 0 {
        return Err(peer_rejected());
    }
    Ok(ProcessBirth {
        image: OsString::from_wide(path),
        creation_time,
    })
}

fn ensure_live(process: &OwnedHandle) -> io::Result<()> {
    // SAFETY: retained process handle; zero milliseconds is a nonblocking status query.
    match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
        WAIT_TIMEOUT => Ok(()),
        WAIT_FAILED => Err(io::Error::last_os_error()),
        _ => Err(peer_rejected()),
    }
}

fn peer_rejected() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "owner pipe process binding rejected",
    )
}

/// Takes ownership of the result of a Win32 call transferring a fresh handle.
pub(super) unsafe fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: caller transfers the fresh, valid handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
