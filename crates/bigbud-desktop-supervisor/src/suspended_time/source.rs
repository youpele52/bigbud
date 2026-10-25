//! Platform clock reads. Each platform is a small `cfg`-gated function with
//! the same signature; conversions live in `convert.rs`.

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use super::convert;

/// Reads the platform's suspended-time counter, or `None` when the clocks are
/// unavailable on this platform or the read failed.
pub fn read_system_suspended_millis() -> Option<u64> {
    platform::read()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::convert::timespec_difference_millis;

    pub(super) fn read() -> Option<u64> {
        // Read MONOTONIC first so the pair can only over-report by the few
        // nanoseconds between the two calls, never under-report.
        let monotonic = clock(libc::CLOCK_MONOTONIC)?;
        let boottime = clock(libc::CLOCK_BOOTTIME)?;
        timespec_difference_millis(boottime, monotonic)
    }

    // `time_t` and `c_long` are 32-bit on some Linux targets, so the
    // widening conversions below are only redundant on 64-bit ones.
    #[allow(clippy::useless_conversion)]
    fn clock(clock_id: libc::clockid_t) -> Option<(i64, i64)> {
        let mut value = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `value` is a valid, writable timespec owned by this frame,
        // and clock_gettime only writes that struct for a supported clock id.
        let status = unsafe { libc::clock_gettime(clock_id, &mut value) };
        if status != 0 {
            return None;
        }
        Some((i64::from(value.tv_sec), i64::from(value.tv_nsec)))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::convert::mach_ticks_difference_millis;

    /// `mach_timebase_info_data_t` from `<mach/mach_time.h>`.
    #[repr(C)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }

    // Declared here because `libc` deprecates its Mach bindings. All three
    // live in libSystem; `mach_continuous_time` since macOS 10.12.
    unsafe extern "C" {
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
        fn mach_absolute_time() -> u64;
        fn mach_continuous_time() -> u64;
    }

    pub(super) fn read() -> Option<u64> {
        let mut timebase = MachTimebaseInfo { numer: 0, denom: 0 };
        // SAFETY: `timebase` is a valid, writable, `repr(C)` struct owned by
        // this frame with the kernel's layout; the call only fills it in.
        if unsafe { mach_timebase_info(&mut timebase) } != 0 {
            return None;
        }
        // SAFETY: both functions take no arguments, touch no caller memory,
        // and only read the kernel's tick counters. Read the non-sleeping
        // clock first so the difference can only over-report by a few ticks.
        let absolute = unsafe { mach_absolute_time() };
        // SAFETY: see above.
        let continuous = unsafe { mach_continuous_time() };
        mach_ticks_difference_millis(continuous, absolute, timebase.numer, timebase.denom)
    }
}

#[cfg(windows)]
mod platform {
    use super::convert::interrupt_time_difference_millis;
    use windows_sys::Win32::System::WindowsProgramming::{
        QueryInterruptTime, QueryUnbiasedInterruptTime,
    };

    pub(super) fn read() -> Option<u64> {
        let mut unbiased = 0_u64;
        // SAFETY: `unbiased` is a valid, writable u64 owned by this frame; the
        // call only writes the current unbiased interrupt time into it. Read
        // the clock that excludes sleep first so the pair can only over-report.
        if unsafe { QueryUnbiasedInterruptTime(&mut unbiased) } == 0 {
            return None;
        }
        let mut interrupt = 0_u64;
        // SAFETY: `interrupt` is a valid, writable u64 owned by this frame;
        // QueryInterruptTime only writes the current interrupt time into it.
        unsafe { QueryInterruptTime(&mut interrupt) };
        Some(interrupt_time_difference_millis(interrupt, unbiased))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    pub(super) fn read() -> Option<u64> {
        None
    }
}
