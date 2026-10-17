use crate::monitor_v1 as v1;
use bigbud_system::{
    inventory::Page,
    inventory::truncate_utf8,
    model::{Availability, Field, Snapshot},
};
use std::time::UNIX_EPOCH;

pub(super) fn status(value: Availability) -> &'static str {
    match value {
        Availability::Ready => "ready",
        Availability::Warming => "warming",
        Availability::Unsupported => "unsupported",
        Availability::Denied => "denied",
        Availability::Unavailable => "unavailable",
        Availability::Stale => "stale",
    }
}
fn at<T>(field: &Field<T>) -> u64 {
    field
        .sampled_at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
pub(super) fn metric<T: Copy + Into<f64>>(field: &Field<T>) -> v1::Metric {
    v1::Metric {
        value: field.value.map_or(0.0, Into::into),
        status: status(field.status).into(),
        sampled_at_ms: at(field),
    }
}
pub(super) fn bytes(field: &Field<u64>) -> v1::Metric {
    v1::Metric {
        value: field.value.map_or(0.0, |v| v as f64),
        status: status(field.status).into(),
        sampled_at_ms: at(field),
    }
}
fn count(field: &Field<usize>) -> v1::Metric {
    v1::Metric {
        value: field.value.map_or(0.0, |v| v as f64),
        status: status(field.status).into(),
        sampled_at_ms: at(field),
    }
}
fn flag(field: &Field<bool>) -> v1::Flag {
    v1::Flag {
        value: field.value.unwrap_or(false),
        status: status(field.status).into(),
        sampled_at_ms: at(field),
    }
}
fn load(field: &Field<[f64; 3]>, index: usize) -> v1::Metric {
    v1::Metric {
        value: field
            .value
            .and_then(|values| values.get(index).copied())
            .unwrap_or(0.0),
        status: status(field.status).into(),
        sampled_at_ms: at(field),
    }
}

pub fn snapshot(
    value: &Snapshot,
    subscription_id: u64,
    epoch: u64,
    sequence: u64,
    baseline: bool,
    process_status: Availability,
    summary_status: Availability,
) -> v1::Snapshot {
    v1::Snapshot {
        app_resources: value
            .app_resources
            .as_ref()
            .map(super::app_resources::snapshot),
        subscription_id,
        epoch,
        sequence,
        baseline,
        sampled_at_ms: value
            .sampled_at
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64),
        hostname: truncate_utf8(
            value.host.hostname.value.as_deref().unwrap_or_default(),
            256,
        ),
        cpu_percent: Some(metric(&value.cpu.total_percent)),
        per_core_percent: value
            .cpu
            .per_core_percent
            .iter()
            .take(128)
            .enumerate()
            .map(|(i, field)| v1::NamedMetric {
                name: i.to_string(),
                metric: Some(metric(field)),
            })
            .collect(),
        memory_total_bytes: Some(bytes(&value.memory.total_bytes)),
        memory_used_bytes: Some(bytes(&value.memory.used_bytes)),
        memory_available_bytes: Some(bytes(&value.memory.available_bytes)),
        swap_total_bytes: Some(bytes(&value.memory.swap_total_bytes)),
        swap_used_bytes: Some(bytes(&value.memory.swap_used_bytes)),
        swap_free_bytes: Some(bytes(&value.memory.swap_free_bytes)),
        network_received_bytes_per_second: Some(metric(&value.network.received_bytes_per_second)),
        network_transmitted_bytes_per_second: Some(metric(
            &value.network.transmitted_bytes_per_second,
        )),
        disk_capacity_bytes: value
            .disks
            .as_ref()
            .map(|d| bytes(&d.aggregate_capacity_bytes)),
        temperatures_celsius: value.sensors.as_ref().map_or_else(Vec::new, |sensors| {
            sensors
                .iter()
                .take(16)
                .map(|s| v1::NamedMetric {
                    name: s.label.clone(),
                    metric: Some(metric(&s.temperature_celsius)),
                })
                .collect()
        }),
        process_status: status(process_status).into(),
        summary_status: status(summary_status).into(),
        disks: value.disks.as_ref().map_or_else(Vec::new, |observation| {
            observation
                .disks
                .iter()
                .take(16)
                .map(|disk| v1::DiskRow {
                    name: disk.name.clone(),
                    mount: disk.mount.clone(),
                    filesystem: disk.filesystem.clone(),
                    total_bytes: Some(bytes(&disk.total_bytes)),
                    free_bytes: Some(bytes(&disk.free_bytes)),
                    used_bytes: Some(bytes(&disk.used_bytes)),
                    read_bytes_per_second: Some(metric(&disk.read_bytes_per_second)),
                    written_bytes_per_second: Some(metric(&disk.written_bytes_per_second)),
                    removable: Some(flag(&disk.removable)),
                    read_only: Some(flag(&disk.read_only)),
                })
                .collect()
        }),
        interfaces: value
            .network
            .interfaces
            .iter()
            .take(16)
            .map(|interface| v1::NetworkRow {
                name: interface.name.clone(),
                received_total_bytes: Some(bytes(&interface.received_total_bytes)),
                transmitted_total_bytes: Some(bytes(&interface.transmitted_total_bytes)),
                received_bytes_per_second: Some(metric(&interface.received_bytes_per_second)),
                transmitted_bytes_per_second: Some(metric(&interface.transmitted_bytes_per_second)),
                receive_errors: Some(bytes(&interface.receive_errors)),
                transmit_errors: Some(bytes(&interface.transmit_errors)),
                received_packets: Some(bytes(&interface.received_packets)),
                transmitted_packets: Some(bytes(&interface.transmitted_packets)),
                link_state: Some(v1::TextField {
                    value: interface
                        .link_state
                        .value
                        .map_or("unknown", |state| state.as_str())
                        .into(),
                    status: status(interface.link_state.status).into(),
                    sampled_at_ms: at(&interface.link_state),
                }),
                mtu_bytes: Some(bytes(&interface.mtu_bytes)),
            })
            .collect(),
        os_name: truncate_utf8(value.host.os_name.value.as_deref().unwrap_or_default(), 256),
        os_version: truncate_utf8(
            value.host.os_version.value.as_deref().unwrap_or_default(),
            256,
        ),
        architecture: truncate_utf8(
            value.host.architecture.value.as_deref().unwrap_or_default(),
            256,
        ),
        uptime_seconds: Some(bytes(&value.host.uptime_seconds)),
        per_core_truncated: value.cpu.per_core_percent.len() > 128,
        disks_truncated: value.disks.as_ref().is_some_and(|d| d.disks.len() > 16),
        interfaces_truncated: value.network.interfaces.len() > 16,
        sensors_truncated: value.sensors.as_ref().is_some_and(|s| s.len() > 16),
        logical_cores: Some(v1::Metric {
            value: value.host.logical_cores.value.map_or(0.0, |v| v as f64),
            status: status(value.host.logical_cores.status).into(),
            sampled_at_ms: at(&value.host.logical_cores),
        }),
        kernel_version: truncate_utf8(
            value
                .host
                .kernel_version
                .value
                .as_deref()
                .unwrap_or_default(),
            256,
        ),
        boot_time_seconds: Some(bytes(&value.host.boot_time_seconds)),
        physical_cores: Some(count(&value.host.physical_cores)),
        cpu_brand: truncate_utf8(
            value.host.cpu_brand.value.as_deref().unwrap_or_default(),
            256,
        ),
        cpu_frequency_mhz: Some(bytes(&value.host.cpu_frequency_mhz)),
        load_average_one: Some(load(&value.host.load_average, 0)),
        load_average_five: Some(load(&value.host.load_average, 1)),
        load_average_fifteen: Some(load(&value.host.load_average, 2)),
        critical_temperatures_celsius: value.sensors.as_ref().map_or_else(Vec::new, |sensors| {
            sensors
                .iter()
                .take(16)
                .map(|s| v1::NamedMetric {
                    name: s.label.clone(),
                    metric: Some(metric(&s.critical_celsius)),
                })
                .collect()
        }),
    }
}

pub fn page(value: Page, request_id: u64) -> v1::ProcessPage {
    let (next_digest, next_offset) = value
        .next
        .map_or((0, 0), |next| (next.digest, next.offset as u32));
    v1::ProcessPage {
        request_id,
        rows: value
            .rows
            .into_iter()
            .map(|row| v1::ProcessRow {
                pid: row.pid,
                parent_pid: row.parent_pid,
                name: row.name,
                status: row.status,
                start_time_seconds: row.start_time_seconds,
                run_time_seconds: row.run_time_seconds,
                cpu_percent: Some(v1::Metric {
                    value: row.cpu_percent.map_or(0.0, f64::from),
                    status: if row.cpu_percent.is_some() {
                        "ready"
                    } else {
                        "unavailable"
                    }
                    .into(),
                    sampled_at_ms: 0,
                }),
                resident_bytes: row.resident_bytes,
                virtual_bytes: row.virtual_bytes,
                disk_read_bytes: row.disk_read_bytes,
                disk_written_bytes: row.disk_written_bytes,
            })
            .collect(),
        truncated_inventory: value.truncated_inventory,
        generation: value.generation,
        next_digest,
        next_offset,
    }
}
