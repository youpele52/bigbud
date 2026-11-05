use super::identity::{ProcessIdentity, boot_uuid, invalid};
use std::{
    io,
    mem::{MaybeUninit, size_of},
    num::NonZeroU32,
};

pub(super) fn inspect(pid: NonZeroU32) -> io::Result<ProcessIdentity> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    // SAFETY: live writable storage has precisely the requested ABI size. The
    // signed PID was checked by inspect; no pointer escapes this call.
    let count = unsafe {
        libc::proc_pidinfo(
            pid.get() as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if count <= 0 {
        return Err(io::Error::last_os_error());
    }
    if count as usize != size_of::<libc::proc_bsdinfo>() {
        return Err(invalid());
    }
    // SAFETY: proc_pidinfo returned the complete initialized BSD-info structure.
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid.get() || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000
    {
        return Err(invalid());
    }
    let mut boot = [0_u8; 37];
    let mut size = boot.len();
    // SAFETY: NUL-terminated constant name; output and length pointers are valid,
    // bounded writable storage. Null newp/zero newlen makes this read-only.
    let status = unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            boot.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    if size != boot.len() || boot.last() != Some(&0) {
        return Err(invalid());
    }
    let uuid = boot_uuid(boot.get(..36).ok_or_else(invalid)?)?;
    Ok(ProcessIdentity {
        pid,
        parent: info.pbi_ppid,
        group: info.pbi_pgid,
        creation: format!(
            "darwin:{uuid}:{}:{}",
            info.pbi_start_tvsec, info.pbi_start_tvusec
        ),
    })
}
