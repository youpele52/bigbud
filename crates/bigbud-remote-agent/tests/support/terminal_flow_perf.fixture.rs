//! Performance gates for the terminal flow tests.
//!
//! Correctness (complete, in-order output; no cross-connection blocking; an honest screen
//! model) is asserted on every run. Absolute wall-clock budgets only mean something on an
//! otherwise idle machine, so they are enforced only when `BIGBUD_TERMINAL_PERF_STRICT=1`
//! (a dedicated perf job). Default runs instead compare latency with a baseline calibrated
//! in the same run, which still catches head-of-line blocking on a loaded machine.

use std::time::Duration;

/// Set to `1` to enforce the absolute budgets (quiet, dedicated machine).
pub const STRICT_ENV: &str = "BIGBUD_TERMINAL_PERF_STRICT";

/// Strict budgets assume optimised code; a debug build would fail them for no product reason.
pub fn strict() -> bool {
    let strict = std::env::var(STRICT_ENV).is_ok_and(|value| value == "1");
    assert!(
        !(strict && cfg!(debug_assertions)),
        "{STRICT_ENV}=1 needs an optimised build (cargo test --release)"
    );
    strict
}

/// The `percent`th percentile of `samples` (sorted in place).
pub fn percentile(samples: &mut [Duration], percent: usize) -> Duration {
    assert!(!samples.is_empty(), "no latency samples");
    samples.sort();
    samples[(samples.len() * percent / 100).min(samples.len() - 1)]
}

/// Absolute p99 budget for echo while another PTY floods (strict mode only).
pub const STRICT_ECHO_P99: Duration = Duration::from_millis(5);
/// Relative budget: a flood may slow echo by this factor over the calibrated idle p99...
pub const RELATIVE_ECHO_FACTOR: u32 = 8;
/// ...but never needs to beat this floor (scheduler jitter dominates below it).
pub const RELATIVE_ECHO_FLOOR: Duration = Duration::from_millis(25);
/// The median is stable even on a shared machine, so it gets a tighter relative floor: a
/// flood that queued echo behind shared output would move it by far more than this.
pub const RELATIVE_MEDIAN_FLOOR: Duration = Duration::from_millis(2);
/// No single echo may wait this long: a stalled peer holding the PTY back blocks for seconds.
pub const ECHO_MAX: Duration = Duration::from_secs(1);

/// Asserts the echo latency under flood against the strict or calibrated budget.
pub fn assert_echo_latency(baseline: &mut [Duration], loaded: &mut [Duration]) {
    let baseline_p50 = percentile(baseline, 50);
    let baseline_p99 = percentile(baseline, 99);
    let p50 = percentile(loaded, 50);
    let p99 = percentile(loaded, 99);
    let max = *loaded.last().unwrap_or(&Duration::ZERO);
    eprintln!(
        "echo idle p50 {baseline_p50:?} p99 {baseline_p99:?}; under flood p50 {p50:?} p99 {p99:?} max {max:?} \
         over {} samples (strict: {})",
        loaded.len(),
        strict()
    );
    assert!(
        max < ECHO_MAX,
        "an echo waited {max:?}: head-of-line blocking"
    );
    if strict() {
        assert!(p99 < STRICT_ECHO_P99, "echo p99 {p99:?}");
    } else {
        let budget = (baseline_p99 * RELATIVE_ECHO_FACTOR).max(RELATIVE_ECHO_FLOOR);
        assert!(
            p99 < budget,
            "echo p99 {p99:?} exceeds {budget:?} (idle p99 {baseline_p99:?})"
        );
        let median_budget = (baseline_p50 * RELATIVE_ECHO_FACTOR).max(RELATIVE_MEDIAN_FLOOR);
        assert!(
            p50 < median_budget,
            "echo p50 {p50:?} exceeds {median_budget:?} (idle p50 {baseline_p50:?})"
        );
    }
}
