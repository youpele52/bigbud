use std::time::SystemTime;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Availability {
    Ready,
    Warming,
    Unsupported,
    Denied,
    Unavailable,
    Stale,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field<T> {
    pub value: Option<T>,
    pub status: Availability,
    pub sampled_at: SystemTime,
}

impl<T> Field<T> {
    pub fn ready(value: T, sampled_at: SystemTime) -> Self {
        Self {
            value: Some(value),
            status: Availability::Ready,
            sampled_at,
        }
    }

    pub fn absent(status: Availability, sampled_at: SystemTime) -> Self {
        Self {
            value: None,
            status,
            sampled_at,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Host {
    pub hostname: Field<String>,
    pub os_name: Field<String>,
    pub os_version: Field<String>,
    pub kernel_version: Field<String>,
    pub architecture: Field<String>,
    pub uptime_seconds: Field<u64>,
    pub boot_time_seconds: Field<u64>,
    pub physical_cores: Field<usize>,
    pub logical_cores: Field<usize>,
    pub cpu_brand: Field<String>,
    pub cpu_frequency_mhz: Field<u64>,
    pub load_average: Field<[f64; 3]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostIdentity {
    pub hostname: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub architecture: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Cpu {
    pub total_percent: Field<f32>,
    pub per_core_percent: Vec<Field<f32>>,
}

#[derive(Clone, Debug)]
pub struct Memory {
    pub total_bytes: Field<u64>,
    pub used_bytes: Field<u64>,
    pub available_bytes: Field<u64>,
    pub swap_total_bytes: Field<u64>,
    pub swap_used_bytes: Field<u64>,
    pub swap_free_bytes: Field<u64>,
}

#[derive(Clone, Debug)]
pub struct Disk {
    pub name: String,
    pub mount: String,
    pub filesystem: String,
    pub total_bytes: Field<u64>,
    pub free_bytes: Field<u64>,
    pub used_bytes: Field<u64>,
    pub removable: Field<bool>,
    pub read_only: Field<bool>,
    pub read_bytes_per_second: Field<f64>,
    pub written_bytes_per_second: Field<f64>,
}

#[derive(Clone, Debug)]
pub struct DiskObservation {
    pub disks: Vec<Disk>,
    pub aggregate_capacity_bytes: Field<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LinkState {
    Up,
    Down,
    Testing,
    Unknown,
    Dormant,
    NotPresent,
    LowerLayerDown,
}

impl LinkState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Testing => "testing",
            Self::Unknown => "unknown",
            Self::Dormant => "dormant",
            Self::NotPresent => "not-present",
            Self::LowerLayerDown => "lower-layer-down",
        }
    }
}

#[derive(Clone, Debug)]
pub struct NetworkInterface {
    pub name: String,
    pub link_state: Field<LinkState>,
    pub mtu_bytes: Field<u64>,
    pub received_total_bytes: Field<u64>,
    pub transmitted_total_bytes: Field<u64>,
    pub received_bytes_per_second: Field<f64>,
    pub transmitted_bytes_per_second: Field<f64>,
    pub received_packets: Field<u64>,
    pub transmitted_packets: Field<u64>,
    pub receive_errors: Field<u64>,
    pub transmit_errors: Field<u64>,
}

#[derive(Clone, Debug)]
pub struct NetworkObservation {
    pub interfaces: Vec<NetworkInterface>,
    pub received_bytes_per_second: Field<f64>,
    pub transmitted_bytes_per_second: Field<f64>,
}

#[derive(Clone, Debug)]
pub struct Sensor {
    pub label: String,
    pub temperature_celsius: Field<f32>,
    pub critical_celsius: Field<f32>,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub host: Host,
    pub cpu: Cpu,
    pub memory: Memory,
    pub disks: Option<DiskObservation>,
    pub disks_status: Option<Availability>,
    pub network: NetworkObservation,
    pub sensors: Option<Vec<Sensor>>,
    pub sensors_status: Option<Availability>,
    pub sampled_at: SystemTime,
}

pub(crate) fn optional<T>(value: Option<T>, at: SystemTime) -> Field<T> {
    match value {
        Some(value) => Field::ready(value, at),
        None => Field::absent(Availability::Unavailable, at),
    }
}

pub(crate) fn finite(value: Option<f32>, at: SystemTime) -> Field<f32> {
    optional(value.filter(|value| value.is_finite()), at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_nan_are_not_zero() {
        let at = SystemTime::UNIX_EPOCH;
        assert_eq!(finite(Some(f32::NAN), at).status, Availability::Unavailable);
        assert_eq!(finite(None, at).value, None);
    }
}
