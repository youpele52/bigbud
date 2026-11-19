//! Lowers the CPU (and, where possible, I/O) priority of the calling walker thread, so a
//! background search cannot compete with active turns on a small host. Called once per walker
//! thread from the `WalkParallel::run` factory. Failures are ignored on purpose: a search that
//! keeps normal priority is still correct, only less polite.

/// Returns whether the platform accepted the change (used by tests and diagnostics only).
pub fn lower_current_thread_priority() -> bool {
    imp::lower()
}

#[cfg(target_os = "macos")]
mod imp {
    pub fn lower() -> bool {
        // SAFETY: `pthread_set_qos_class_self_np` only changes the calling thread's QoS class; the
        // arguments are a valid class constant and a relative priority of 0.
        unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0) == 0 }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    /// `IOPRIO_PRIO_VALUE(IOPRIO_CLASS_BE, 7)`: best effort, lowest level.
    const IOPRIO_BEST_EFFORT_LOWEST: libc::c_long = (2 << 13) | 7;
    const IOPRIO_WHO_PROCESS: libc::c_long = 1;

    pub fn lower() -> bool {
        // SAFETY: on Linux `setpriority(PRIO_PROCESS, 0, …)` targets only the calling thread (nice
        // values are per thread); raising niceness needs no privilege.
        let cpu = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, 10) } == 0;
        // SAFETY: `ioprio_set` with who = 0 targets the calling thread; lowering the best-effort
        // level needs no privilege and touches no memory.
        let io = unsafe {
            libc::syscall(
                libc::SYS_ioprio_set,
                IOPRIO_WHO_PROCESS,
                0,
                IOPRIO_BEST_EFFORT_LOWEST,
            )
        } == 0;
        cpu && io
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
    };

    pub fn lower() -> bool {
        // SAFETY: `GetCurrentThread` returns a pseudo-handle that needs no closing, and background
        // mode only lowers the calling thread's CPU and I/O priority.
        unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) != 0 }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    pub fn lower() -> bool {
        false
    }
}
