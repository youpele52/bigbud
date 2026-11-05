//! libSystem only; no Apple framework or persisted monotonic timestamps.
use std::io;

unsafe extern "C" {
    // Installed public mach/mach_time.h: uint64_t, advances during sleep.
    fn mach_continuous_time() -> u64;
}

// Reuse the approved locked libc ABI; adding mach2 is not authorized.
#[allow(deprecated)]
pub(super) fn now_ns() -> io::Result<u64> {
    let mut info = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: initialized writable storage with libc's public two-u32 ABI;
    // mach_timebase_info writes only this structure and retains no pointer.
    if unsafe { libc::mach_timebase_info(&mut info) } != 0 {
        return Err(io::Error::other("continuous clock timebase unavailable"));
    }
    // SAFETY: public libSystem no-argument scalar clock; no resource ownership,
    // desktop/session query, callback, framework or permission interaction.
    let ticks = unsafe { mach_continuous_time() };
    convert(ticks, info.numer, info.denom)
}

fn convert(ticks: u64, numer: u32, denom: u32) -> io::Result<u64> {
    if numer == 0 || denom == 0 {
        return Err(io::Error::other("invalid continuous timebase"));
    }
    let ns = u128::from(ticks)
        .checked_mul(u128::from(numer))
        .and_then(|value| value.checked_div(u128::from(denom)))
        .and_then(|value| u64::try_from(value).ok());
    ns.ok_or_else(|| io::Error::other("continuous clock overflow"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn checked_units_and_invalid_or_overflowing_timebase() {
        assert_eq!(convert(600, 125, 3).unwrap(), 25_000);
        assert_eq!(convert(1, 1, 3).unwrap(), 0);
        assert_eq!(convert(u64::MAX, 1, 1).unwrap(), u64::MAX);
        assert!(convert(1, 0, 1).is_err());
        assert!(convert(1, 1, 0).is_err());
        assert!(convert(u64::MAX, 2, 1).is_err());
        // Widen before multiplication; a representable quotient is not overflow.
        assert_eq!(convert(u64::MAX, u32::MAX, u32::MAX).unwrap(), u64::MAX);
    }
    #[test]
    fn actual_continuous_clock_is_readable_not_a_session_query() {
        let before = now_ns().unwrap();
        assert!(now_ns().unwrap() >= before);
    }
}
