use super::convert::{
    interrupt_time_difference_millis, mach_ticks_difference_millis, timespec_difference_millis,
};
use super::{SuspendedTime, read_system_suspended_millis};

#[test]
fn linux_boottime_minus_monotonic_is_suspended_millis() {
    assert_eq!(
        timespec_difference_millis((1_000, 500_000_000), (100, 0)),
        Some(900_500)
    );
    assert_eq!(timespec_difference_millis((5, 0), (5, 0)), Some(0));
}

#[test]
fn linux_reading_jitter_saturates_instead_of_wrapping() {
    assert_eq!(timespec_difference_millis((5, 0), (5, 1)), Some(0));
}

#[test]
fn linux_rejects_invalid_timespecs() {
    assert_eq!(timespec_difference_millis((-1, 0), (0, 0)), None);
    assert_eq!(timespec_difference_millis((1, 1_000_000_000), (0, 0)), None);
}

#[test]
fn macos_mach_ticks_use_the_timebase() {
    // Apple silicon: 125/3 ns per tick, so 24_000_000 ticks are 1 s.
    assert_eq!(
        mach_ticks_difference_millis(124_000_000, 100_000_000, 125, 3),
        Some(1_000)
    );
    // Intel: 1/1, ticks are nanoseconds.
    assert_eq!(
        mach_ticks_difference_millis(1_800_000_000_000, 0, 1, 1),
        Some(1_800_000)
    );
    assert_eq!(mach_ticks_difference_millis(10, 20, 1, 1), Some(0));
}

#[test]
fn macos_rejects_an_empty_timebase() {
    assert_eq!(mach_ticks_difference_millis(10, 0, 0, 1), None);
    assert_eq!(mach_ticks_difference_millis(10, 0, 1, 0), None);
}

#[test]
fn macos_large_tick_counts_do_not_overflow() {
    assert_eq!(
        mach_ticks_difference_millis(u64::MAX, 0, 125, 3),
        Some((u128::from(u64::MAX) * 125 / 3 / 1_000_000) as u64)
    );
}

#[test]
fn windows_interrupt_time_is_in_100ns_units() {
    // 30 minutes of sleep: 18_000_000_000 units of 100 ns.
    assert_eq!(
        interrupt_time_difference_millis(18_000_000_000 + 5, 5),
        1_800_000
    );
    assert_eq!(interrupt_time_difference_millis(1, 2), 0);
}

#[test]
fn readings_never_regress_and_survive_a_failed_read() {
    fn sequence() -> Option<u64> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        match CALLS.fetch_add(1, Ordering::Relaxed) {
            0 => Some(1_000),
            1 => Some(999),
            2 => None,
            _ => Some(16_000),
        }
    }
    let mut clock = SuspendedTime::from_source(sequence);
    assert_eq!(clock.read_millis(), 1_000);
    assert_eq!(clock.read_millis(), 1_000);
    assert_eq!(clock.read_millis(), 1_000);
    assert_eq!(clock.read_millis(), 16_000);
}

#[test]
fn unavailable_source_reports_a_constant_zero() {
    let mut clock = SuspendedTime::from_source(|| None);
    assert_eq!(clock.read_millis(), 0);
    assert_eq!(clock.read_millis(), 0);
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[test]
fn the_host_clock_pair_is_readable_and_monotonic() {
    let first = read_system_suspended_millis();
    let second = read_system_suspended_millis();
    let (Some(first), Some(second)) = (first, second) else {
        panic!("the suspended-time clock pair must be readable on this platform");
    };
    // Back-to-back reads may jitter by at most a millisecond of rounding.
    assert!(second + 1 >= first, "{second} regressed below {first}");
}
