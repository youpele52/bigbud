//! Pure unit conversions for the per-OS clock pairs. Kept platform-neutral so
//! every conversion is unit-tested on every host.

const NANOS_PER_MILLI: u128 = 1_000_000;
const HUNDRED_NANOS_PER_MILLI: u64 = 10_000;

/// Linux: `CLOCK_BOOTTIME − CLOCK_MONOTONIC`, both as (seconds, nanoseconds).
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
pub(super) fn timespec_difference_millis(
    boottime: (i64, i64),
    monotonic: (i64, i64),
) -> Option<u64> {
    let boottime = timespec_nanos(boottime)?;
    let monotonic = timespec_nanos(monotonic)?;
    Some(saturating_millis(boottime.saturating_sub(monotonic)))
}

/// macOS: `mach_continuous_time − mach_absolute_time` in Mach ticks, converted
/// with the timebase ratio `numer / denom` to nanoseconds.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub(super) fn mach_ticks_difference_millis(
    continuous_ticks: u64,
    absolute_ticks: u64,
    numer: u32,
    denom: u32,
) -> Option<u64> {
    if numer == 0 || denom == 0 {
        return None;
    }
    let ticks = u128::from(continuous_ticks.saturating_sub(absolute_ticks));
    let nanos = ticks.checked_mul(u128::from(numer))? / u128::from(denom);
    Some(saturating_millis(nanos))
}

/// Windows: `QueryInterruptTime − QueryUnbiasedInterruptTime`, 100 ns units.
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
pub(super) fn interrupt_time_difference_millis(interrupt: u64, unbiased: u64) -> u64 {
    interrupt.saturating_sub(unbiased) / HUNDRED_NANOS_PER_MILLI
}

fn timespec_nanos((seconds, nanoseconds): (i64, i64)) -> Option<u128> {
    if seconds < 0 || !(0..1_000_000_000).contains(&nanoseconds) {
        return None;
    }
    let seconds = u128::try_from(seconds).ok()?;
    let nanoseconds = u128::try_from(nanoseconds).ok()?;
    Some(seconds * 1_000_000_000 + nanoseconds)
}

fn saturating_millis(nanos: u128) -> u64 {
    // Saturating is a safe fallback: u64 milliseconds overflow only after
    // hundreds of millions of years of suspend, which no real reading reaches.
    u64::try_from(nanos / NANOS_PER_MILLI).unwrap_or(u64::MAX)
}
