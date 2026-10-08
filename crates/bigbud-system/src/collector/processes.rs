use super::Collector;
use crate::{
    inventory::{Inventory, ProcessRecord},
    model::Availability,
};
use std::time::Instant;

impl Collector {
    pub(super) fn inventory(&self, at: Instant, cpu_ready: bool) -> Inventory {
        Inventory::from_records(
            self.generation,
            at,
            self.system.processes().iter().map(|(pid, process)| {
                let usage = process.disk_usage();
                ProcessRecord {
                    pid: pid.as_u32(),
                    parent_pid: process.parent().map(|pid| pid.as_u32()),
                    name: process.name().to_string_lossy().into_owned(),
                    status: format!("{:?}", process.status()),
                    start_time_seconds: process.start_time(),
                    run_time_seconds: process.run_time(),
                    cpu_percent: (cpu_ready && process.cpu_usage().is_finite())
                        .then_some(process.cpu_usage()),
                    cpu_status: if !cpu_ready {
                        Availability::Warming
                    } else if process.cpu_usage().is_finite() {
                        Availability::Ready
                    } else {
                        Availability::Unavailable
                    },
                    resident_bytes: process.memory(),
                    virtual_bytes: process.virtual_memory(),
                    disk_read_bytes: usage.total_read_bytes,
                    disk_written_bytes: usage.total_written_bytes,
                    disk_io_status: if usage.total_read_bytes > 0 || usage.total_written_bytes > 0 {
                        Availability::Ready
                    } else {
                        Availability::Unavailable
                    },
                }
            }),
        )
    }
}
