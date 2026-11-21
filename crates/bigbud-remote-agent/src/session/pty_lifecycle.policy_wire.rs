//! Maps the 1.9 wire `HostPolicy` onto `terminal_policy::HostPolicy` and back (plan §8.7).
//! Zero numeric values mean the host default; Rust clamps everything afterwards.

use bigbud_protocol::v1;

use crate::terminal_policy::HostPolicy;

fn or_default<T: PartialEq + Default>(value: T, default: T) -> T {
    if value == T::default() {
        default
    } else {
        value
    }
}

/// The policy to apply and whether memory-pressure closes are enabled. A missing policy is
/// the default (lifecycle off).
pub(crate) fn policy_from_wire(wire: Option<&v1::HostPolicy>) -> (HostPolicy, bool) {
    let defaults = HostPolicy::default();
    let Some(wire) = wire else {
        return (defaults, false);
    };
    let mut memory = defaults.memory.clone();
    memory.available_low_percent = or_default(
        u64::from(wire.memory_available_low_percent),
        memory.available_low_percent,
    );
    memory.available_critical_percent = or_default(
        u64::from(wire.memory_available_critical_percent),
        memory.available_critical_percent,
    );
    memory.host_rss_low = or_default(wire.host_rss_low_bytes, memory.host_rss_low);
    memory.host_rss_critical = or_default(wire.host_rss_critical_bytes, memory.host_rss_critical);
    memory.terminal_rss_low_percent = or_default(
        u64::from(wire.terminal_rss_low_percent),
        memory.terminal_rss_low_percent,
    );
    memory.terminal_rss_critical_percent = or_default(
        u64::from(wire.terminal_rss_critical_percent),
        memory.terminal_rss_critical_percent,
    );
    let policy = HostPolicy {
        lifecycle_enabled: wire.lifecycle_enabled,
        idle_ms: or_default(wire.idle_close_ms, defaults.idle_ms),
        warning_ms: or_default(wire.idle_warning_ms, defaults.warning_ms),
        max_live_ptys: or_default(wire.max_live_ptys, defaults.max_live_ptys),
        // Orphan 0 is meaningful ("keep"), so it is passed through unchanged.
        orphan_ms: wire.orphan_close_ms,
        memory,
        revision: wire.revision,
    };
    (policy, wire.memory_pressure_enabled)
}

fn percent(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

pub(crate) fn policy_to_wire(policy: &HostPolicy, pressure_enabled: bool) -> v1::HostPolicy {
    v1::HostPolicy {
        lifecycle_enabled: policy.lifecycle_enabled,
        idle_close_ms: policy.idle_ms,
        idle_warning_ms: policy.warning_ms,
        max_live_ptys: policy.max_live_ptys,
        orphan_close_ms: policy.orphan_ms,
        memory_pressure_enabled: pressure_enabled,
        memory_available_low_percent: percent(policy.memory.available_low_percent),
        memory_available_critical_percent: percent(policy.memory.available_critical_percent),
        host_rss_low_bytes: policy.memory.host_rss_low,
        host_rss_critical_bytes: policy.memory.host_rss_critical,
        terminal_rss_low_percent: percent(policy.memory.terminal_rss_low_percent),
        terminal_rss_critical_percent: percent(policy.memory.terminal_rss_critical_percent),
        revision: policy.revision,
    }
}
