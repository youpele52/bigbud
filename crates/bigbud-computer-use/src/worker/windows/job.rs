use super::ffi::{self, HANDLE};
use crate::worker::{ExecutionRoot, windows_launch};
use std::{
    ffi::c_void,
    io,
    mem::size_of,
    num::NonZeroU32,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};

fn check(ok: ffi::BOOL) -> io::Result<()> {
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: freshly returned, exclusively owned, valid kernel handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Created suspended inside the Job; nothing has executed yet. The caller must
/// durably record `root()` BEFORE `resume`. Dropping this kills the process
/// (TerminateJobObject + kill-on-close), never leaving an unrecorded runner.
pub struct SuspendedRoot {
    parts: Option<Parts>,
    root: ExecutionRoot,
}
struct Parts {
    job: OwnedHandle,
    process: OwnedHandle,
    thread: OwnedHandle,
}
/// Running contained root. Dropping closes the only Job handle, which kills
/// every process still in the Job (kill-on-close); no breakaway is allowed.
pub struct ContainedRoot {
    job: OwnedHandle,
    _process: OwnedHandle,
    root: ExecutionRoot,
}

impl SuspendedRoot {
    pub fn spawn(
        executable: &str,
        role: &str,
        environment: &[(String, String)],
        generation: &str,
    ) -> io::Result<Self> {
        if !crate::guard::record::valid_id(generation) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid generation",
            ));
        }
        let mut command = windows_launch::command_line(executable, role)?;
        let block = windows_launch::environment_block(environment)?;
        let application: Vec<u16> = executable.encode_utf16().chain([0]).collect();
        // SAFETY: NULL attributes => noninheritable unnamed Job handle.
        let job = owned(unsafe { ffi::CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
        let mut limits = ffi::JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // No BREAKAWAY_OK / SILENT_BREAKAWAY_OK: descendants cannot escape.
        limits.BasicLimitInformation.LimitFlags = ffi::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | ffi::JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        let length = u32::try_from(size_of::<ffi::JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .map_err(|_| io::Error::other("invalid limit size"))?;
        // SAFETY: live Job handle; correctly sized initialized limit struct.
        check(unsafe {
            ffi::SetInformationJobObject(
                job.as_raw_handle(),
                ffi::JobObjectExtendedLimitInformation,
                (&limits as *const ffi::JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                length,
            )
        })?;
        // Zeroed (no std handles, no STARTF_* flags) apart from the size.
        let startup = ffi::STARTUPINFOW {
            cb: u32::try_from(size_of::<ffi::STARTUPINFOW>())
                .map_err(|_| io::Error::other("size"))?,
            ..Default::default()
        };
        let mut information = ffi::PROCESS_INFORMATION::default();
        // SAFETY: NUL-terminated owned wide strings/env block outlive the call;
        // mutable command buffer as required; no handle inheritance; suspended.
        check(unsafe {
            ffi::CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                ffi::CREATE_SUSPENDED | ffi::CREATE_UNICODE_ENVIRONMENT | ffi::CREATE_NO_WINDOW,
                block.as_ptr().cast(),
                std::ptr::null(),
                &startup,
                &mut information,
            )
        })?;
        let process = owned(information.hProcess)?;
        let thread = match owned(information.hThread) {
            Ok(thread) => thread,
            Err(error) => {
                // SAFETY: owned suspended process handle; never executed.
                let _terminated = unsafe { ffi::TerminateProcess(process.as_raw_handle(), 1) };
                return Err(error);
            }
        };
        // SAFETY: live Job and suspended process handles we exclusively own.
        if let Err(error) = check(unsafe {
            ffi::AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle())
        }) {
            // Never executed: terminate the suspended orphan before returning.
            // SAFETY: owned process handle; a failure here is reported below.
            let _terminated = unsafe { ffi::TerminateProcess(process.as_raw_handle(), 1) };
            return Err(error);
        }
        let creation = creation_identity(&process, information.dwProcessId)?;
        let pid = NonZeroU32::new(information.dwProcessId)
            .ok_or_else(|| io::Error::other("invalid process id"))?;
        Ok(Self {
            parts: Some(Parts {
                job,
                process,
                thread,
            }),
            root: ExecutionRoot {
                pid,
                creation_identity: creation,
                generation: generation.into(),
            },
        })
    }

    pub fn root(&self) -> &ExecutionRoot {
        &self.root
    }

    /// Only after the guard durably recorded `root()` (admission still closed).
    /// On failure the suspended root is dropped, which terminates its Job.
    pub fn resume(mut self) -> io::Result<ContainedRoot> {
        let parts = self
            .parts
            .take()
            .ok_or_else(|| io::Error::other("suspended root already consumed"))?;
        // SAFETY: owned primary-thread handle of our suspended process.
        if unsafe { ffi::ResumeThread(parts.thread.as_raw_handle()) } == u32::MAX {
            let error = io::Error::last_os_error();
            // SAFETY: owned Job handle; contain the never-resumed process.
            let _terminated = unsafe { ffi::TerminateJobObject(parts.job.as_raw_handle(), 1) };
            return Err(error);
        }
        Ok(ContainedRoot {
            job: parts.job,
            _process: parts.process,
            root: self.root.clone(),
        })
    }
}

impl ContainedRoot {
    pub fn root(&self) -> &ExecutionRoot {
        &self.root
    }
    /// Emergency retirement of every process in the Job. Not settlement.
    pub fn retire(&self) -> io::Result<()> {
        // SAFETY: live owned Job handle.
        check(unsafe { ffi::TerminateJobObject(self.job.as_raw_handle(), 1) })
    }
    /// Settled only when the Job reports zero active processes.
    pub fn settled(&self) -> io::Result<bool> {
        let mut info = ffi::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let length = u32::try_from(size_of::<ffi::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>())
            .map_err(|_| io::Error::other("invalid size"))?;
        // SAFETY: live Job handle; writable correctly sized accounting struct.
        check(unsafe {
            ffi::QueryInformationJobObject(
                self.job.as_raw_handle(),
                ffi::JobObjectBasicAccountingInformation,
                (&mut info as *mut ffi::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                length,
                std::ptr::null_mut(),
            )
        })?;
        Ok(info.ActiveProcesses == 0)
    }
}

impl Drop for SuspendedRoot {
    fn drop(&mut self) {
        if let Some(parts) = &self.parts {
            // SAFETY: owned Job handle; kill-on-close also applies on close.
            let _terminated = unsafe { ffi::TerminateJobObject(parts.job.as_raw_handle(), 1) };
        }
    }
}

fn creation_identity(process: &OwnedHandle, pid: u32) -> io::Result<String> {
    let mut times: [ffi::FILETIME; 4] = Default::default();
    let [creation, exit, kernel, user] = &mut times;
    // SAFETY: owned process handle; four writable FILETIME outputs.
    check(unsafe { ffi::GetProcessTimes(process.as_raw_handle(), creation, exit, kernel, user) })?;
    let stamp = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if stamp == 0 {
        return Err(io::Error::other("missing creation time"));
    }
    Ok(format!("windows:{pid}:{stamp}"))
}
