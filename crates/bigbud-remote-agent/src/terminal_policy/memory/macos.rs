//! macOS memory signals: the kernel's VM pressure level, `hw.memsize` and the host's RSS.

use std::ffi::CStr;

use crate::terminal_policy::pressure::MemorySample;

#[derive(Debug, Clone, Copy, Default)]
pub struct MacosMemorySource;

impl MacosMemorySource {
    pub fn sample(&self) -> MemorySample {
        MemorySample {
            os_level: sysctl_u32(c"kern.memorystatus_vm_pressure_level"),
            total_bytes: sysctl_u64(c"hw.memsize"),
            host_rss_bytes: host_rss(),
            ..MemorySample::default()
        }
    }
}

fn sysctl_u32(name: &CStr) -> Option<u32> {
    let mut value: libc::c_int = 0;
    let mut length = size_of::<libc::c_int>();
    // SAFETY: `value` and `length` describe a live c_int; no new value is written.
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut libc::c_int).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    (result == 0 && length == size_of::<libc::c_int>())
        .then(|| u32::try_from(value).ok())
        .flatten()
}

fn sysctl_u64(name: &CStr) -> Option<u64> {
    let mut value: u64 = 0;
    let mut length = size_of::<u64>();
    // SAFETY: `value` and `length` describe a live u64; no new value is written.
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    (result == 0 && length == size_of::<u64>()).then_some(value)
}

/// `proc_pidinfo(PROC_PIDTASKINFO)` resident size of this process.
fn host_rss() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = i32::try_from(size_of::<libc::proc_taskinfo>()).ok()?;
    // SAFETY: `info` is a live, correctly sized proc_taskinfo; getpid cannot fail.
    let written = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: the kernel filled the whole structure (written == size).
    Some(unsafe { info.assume_init() }.pti_resident_size)
}
