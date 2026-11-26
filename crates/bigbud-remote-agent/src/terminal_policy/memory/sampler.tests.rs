use super::{MemorySampler, parse_level};
use crate::terminal_policy::pressure::{
    MemorySample, MemoryThresholds, PressureGovernor, PressureLevel, classify,
};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

#[test]
fn classifies_each_signal_against_the_plan_thresholds() {
    let thresholds = MemoryThresholds::default();
    let level = |sample: MemorySample| classify(&sample, &thresholds);
    assert_eq!(
        level(MemorySample {
            psi_some_avg10: Some(9.9),
            ..Default::default()
        }),
        PressureLevel::Normal
    );
    assert_eq!(
        level(MemorySample {
            psi_some_avg10: Some(10.0),
            ..Default::default()
        }),
        PressureLevel::Low
    );
    assert_eq!(
        level(MemorySample {
            psi_some_avg10: Some(30.0),
            ..Default::default()
        }),
        PressureLevel::Critical
    );
    assert_eq!(
        level(MemorySample {
            os_level: Some(1),
            ..Default::default()
        }),
        PressureLevel::Normal
    );
    assert_eq!(
        level(MemorySample {
            os_level: Some(2),
            ..Default::default()
        }),
        PressureLevel::Low
    );
    assert_eq!(
        level(MemorySample {
            os_level: Some(4),
            ..Default::default()
        }),
        PressureLevel::Critical
    );
    let memory = |available| MemorySample {
        available_bytes: Some(available),
        total_bytes: Some(32 * GIB),
        ..Default::default()
    };
    // 32 GiB: Low below max(8%, 1 GiB) ≈ 2.56 GiB, Critical below max(4%, 512 MiB) ≈ 1.28 GiB.
    assert_eq!(level(memory(3 * GIB)), PressureLevel::Normal);
    assert_eq!(level(memory(2 * GIB)), PressureLevel::Low);
    assert_eq!(level(memory(GIB)), PressureLevel::Critical);
    let host = |rss| MemorySample {
        host_rss_bytes: Some(rss),
        ..Default::default()
    };
    assert_eq!(level(host(512 * MIB)), PressureLevel::Normal);
    assert_eq!(level(host(513 * MIB)), PressureLevel::Low);
    assert_eq!(level(host(769 * MIB)), PressureLevel::Critical);
    let terminals = |rss| MemorySample {
        terminal_rss_bytes: Some(rss),
        total_bytes: Some(10 * GIB),
        available_bytes: Some(10 * GIB),
        ..Default::default()
    };
    assert_eq!(level(terminals(4 * GIB)), PressureLevel::Normal);
    assert_eq!(level(terminals(6 * GIB)), PressureLevel::Low);
    assert_eq!(level(terminals(8 * GIB)), PressureLevel::Critical);
    // The level is the maximum across signals.
    let mixed = MemorySample {
        psi_some_avg10: Some(11.0),
        os_level: Some(4),
        ..Default::default()
    };
    assert_eq!(level(mixed), PressureLevel::Critical);
}

#[test]
fn pressure_acts_after_two_samples_and_clears_after_three_below_low() {
    use PressureLevel::{Critical, Low, Normal};
    let mut governor = PressureGovernor::default();
    assert_eq!(governor.observe(Low), Normal, "one sample is not enough");
    assert_eq!(governor.observe(Low), Low);
    assert_eq!(
        governor.observe(Critical),
        Low,
        "Critical must also hold twice"
    );
    assert_eq!(governor.observe(Critical), Critical);
    assert_eq!(governor.observe(Normal), Critical);
    assert_eq!(governor.observe(Normal), Critical);
    assert_eq!(governor.observe(Normal), Normal);
}

#[test]
fn pressure_closes_are_spaced_and_capped() {
    use PressureLevel::{Critical, Low};
    let mut governor = PressureGovernor::default();
    governor.observe(Low);
    governor.observe(Low);
    let mut closes = Vec::new();
    for second in (0..300u64).step_by(5) {
        let now = 1_000_000 + second * 1_000;
        if governor.may_close(now) {
            governor.record_close(now);
            closes.push(second);
        }
    }
    assert_eq!(
        closes,
        vec![0, 30, 60],
        "30 s apart, at most 3 per 5 minutes at Low"
    );
    let mut governor = PressureGovernor::default();
    governor.observe(Critical);
    governor.observe(Critical);
    let count = (0..300u64)
        .step_by(30)
        .filter(|second| {
            let now = second * 1_000;
            let allowed = governor.may_close(now);
            if allowed {
                governor.record_close(now);
            }
            allowed
        })
        .count();
    assert_eq!(count, 6, "6 per 5 minutes at Critical");
    assert!(governor.take_no_candidate_notice(0));
    assert!(!governor.take_no_candidate_notice(599_999));
    assert!(governor.take_no_candidate_notice(600_000));
}

#[cfg(debug_assertions)]
#[test]
fn the_debug_override_forces_the_sample_level() {
    assert_eq!(parse_level(" Critical "), Some(PressureLevel::Critical));
    assert_eq!(parse_level("nope"), None);
    let mut sampler = MemorySampler::default();
    sampler.set_pressure_override(Some(PressureLevel::Critical));
    let sample = sampler.sample(Some(1));
    assert_eq!(sample.terminal_rss_bytes, Some(1));
    assert_eq!(
        classify(&sample, &MemoryThresholds::default()),
        PressureLevel::Critical
    );
    sampler.set_pressure_override(None);
    assert_eq!(sampler.sample(None).forced, None);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn the_live_sample_reports_total_memory_and_host_rss() {
    let sample = MemorySampler::default().sample(None);
    assert!(
        sample.total_bytes.is_some_and(|total| total > 256 * MIB),
        "{sample:?}"
    );
    assert!(
        sample.host_rss_bytes.is_some_and(|rss| rss > 0),
        "{sample:?}"
    );
    #[cfg(target_os = "macos")]
    assert!(sample.os_level.is_some(), "{sample:?}");
}
