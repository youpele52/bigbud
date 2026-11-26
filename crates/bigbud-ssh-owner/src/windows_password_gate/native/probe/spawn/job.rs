use super::*;
use windows_sys::Win32::System::Threading::IO_COUNTERS;

// Narrow declarations rather than changing the shared Cargo feature set.
#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    active_processes: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io: IO_COUNTERS,
    process_memory: usize,
    job_memory: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}

const EXTENDED_LIMITS: i32 = 9;
const KILL_ON_CLOSE: u32 = 0x2000;
const ACTIVE_PROCESS_LIMIT: u32 = 0x0008;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const SECURITY_ATTRIBUTES, name: *const u16) -> HANDLE;
    fn SetInformationJobObject(job: HANDLE, class: i32, info: *const c_void, len: u32) -> i32;
}

pub(super) fn kill_on_close() -> io::Result<OwnedHandle> {
    // SAFETY: unnamed, non-inheritable private job; null optional parameters.
    let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateJobObjectW transferred ownership to us.
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let limits = ExtendedLimits {
        basic: BasicLimits {
            flags: KILL_ON_CLOSE | ACTIVE_PROCESS_LIMIT,
            active_processes: 2,
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY: live job and documented repr(C) extended limits; the kernel
    // copies values before returning and keeps no reference to this stack.
    ok(unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            EXTENDED_LIMITS,
            (&raw const limits).cast(),
            size_of::<ExtendedLimits>() as u32,
        )
    })?;
    Ok(job)
}
