#[path = "host.rs"]
mod host;
pub use host::identity as host_identity;
#[path = "network.rs"]
mod network;
#[path = "processes.rs"]
mod processes;
#[path = "recovery.rs"]
mod recovery;
pub use recovery::CollectionError;

use crate::{
    app_resources::{AppTracker, Root},
    inventory::{Inventory, truncate_utf8},
    model::{
        Availability, Cpu, Disk, DiskObservation, Field, Memory, NetworkInterface,
        NetworkObservation, Sensor, Snapshot, finite, optional,
    },
    rate::CounterRate,
};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant, SystemTime},
};
use sysinfo::{Components, Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Clone, Copy, Debug, Default)]
pub struct Demand {
    pub processes: bool,
    pub sensors: bool,
    pub disks: bool,
    pub app_resources: bool,
}

#[derive(Default)]
struct NetworkRates {
    receive: CounterRate,
    transmit: CounterRate,
}

/// One retained sysinfo state for the local host. The owner calls `sample` on its chosen cadence.
/// No worker or OS refresh starts during construction.
pub struct Collector {
    system: System,
    disks: Disks,
    networks: Networks,
    components: Components,
    rates: HashMap<String, NetworkRates>,
    disk_rates: HashMap<String, NetworkRates>,
    last_cpu: Option<Instant>,
    last_network: Option<Instant>,
    last_disks: Option<Instant>,
    latest_disks: Option<DiskObservation>,
    last_sensors: Option<Instant>,
    latest_sensors: Option<Vec<Sensor>>,
    last_processes: Option<Instant>,
    last_app: Option<Instant>,
    app: AppTracker,
    generation: u64,
}

impl Default for Collector {
    fn default() -> Self {
        Self {
            system: System::new(),
            disks: Disks::new(),
            networks: Networks::new(),
            components: Components::new(),
            rates: HashMap::new(),
            disk_rates: HashMap::new(),
            last_cpu: None,
            last_network: None,
            last_disks: None,
            latest_disks: None,
            last_sensors: None,
            latest_sensors: None,
            last_processes: None,
            last_app: None,
            app: AppTracker::default(),
            generation: 0,
        }
    }
}

impl Collector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.system = System::new();
        self.disks = Disks::new();
        self.networks = Networks::new();
        self.components = Components::new();
        self.rates.clear();
        self.disk_rates.clear();
        self.last_cpu = None;
        self.last_network = None;
        self.last_disks = None;
        self.latest_disks = None;
        self.last_sensors = None;
        self.latest_sensors = None;
        self.last_processes = None;
        self.last_app = None;
        self.app.reset();
    }

    pub fn set_app_roots(&mut self, roots: Vec<Root>) -> bool {
        let changed = self.app.set_roots(roots);
        if changed {
            self.last_app = None;
        }
        changed
    }

    pub fn release_app_resources(&mut self) {
        if self.last_app.take().is_some() {
            self.app.reset();
        }
    }

    /// Releases sysinfo's retained process table when no consumer requests it.
    pub fn release_processes(&mut self) {
        if !self.system.processes().is_empty() {
            self.system = System::new();
            self.last_cpu = None;
            self.last_processes = None;
        }
    }

    /// Samples due categories. The optional inventory is returned only when refreshed.
    pub fn sample(&mut self, demand: Demand, now: Instant) -> (Snapshot, Option<Inventory>) {
        let at = SystemTime::now();
        self.system.refresh_memory();
        self.system.refresh_cpu_usage();
        let cpu_ready = self.last_cpu.is_some_and(|old| {
            now.saturating_duration_since(old) >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL
        });
        self.last_cpu = Some(now);
        self.networks.refresh(true);
        let network = self.network(at, now);
        if demand.disks && due(self.last_disks, now, Duration::from_secs(10)) {
            self.disks.refresh(true);
            self.last_disks = Some(now);
            self.latest_disks = Some(self.disk_observation(at, now));
        }
        if demand.sensors && due(self.last_sensors, now, Duration::from_secs(15)) {
            self.components.refresh(true);
            self.last_sensors = Some(now);
            self.latest_sensors = Some(self.sensor_observation(at));
        }
        let disks = demand.disks.then(|| self.latest_disks.clone()).flatten();
        let sensors = demand
            .sensors
            .then(|| self.latest_sensors.clone())
            .flatten();
        let disks_status = demand.disks.then_some(match disks.as_ref() {
            Some(disks) if !disks.disks.is_empty() => Availability::Ready,
            Some(_) => Availability::Unavailable,
            None => Availability::Warming,
        });
        let sensors_status = demand.sensors.then_some(match sensors.as_ref() {
            Some(sensors)
                if sensors
                    .iter()
                    .any(|sensor| sensor.temperature_celsius.status == Availability::Ready) =>
            {
                Availability::Ready
            }
            Some(_) => Availability::Unavailable,
            None => Availability::Warming,
        });
        let inventory = if demand.processes && due(self.last_processes, now, Duration::from_secs(5))
        {
            let process_cpu_ready = self.last_processes.is_some();
            let _updated = self.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_memory()
                    .with_disk_usage(),
            );
            self.last_processes = Some(now);
            self.generation = self.generation.wrapping_add(1);
            Some(self.inventory(now, process_cpu_ready))
        } else {
            None
        };
        if demand.app_resources && due(self.last_app, now, Duration::from_secs(5)) {
            self.app
                .sample(&mut self.system, inventory.is_some(), now, at);
            self.last_app = Some(now);
        }
        let cpu_status = if self.system.cpus().is_empty() {
            Availability::Unavailable
        } else if cpu_ready {
            Availability::Ready
        } else {
            Availability::Warming
        };
        let cpu = Cpu {
            total_percent: percent(self.system.global_cpu_usage(), cpu_status, at),
            per_core_percent: self
                .system
                .cpus()
                .iter()
                .map(|cpu| percent(cpu.cpu_usage(), cpu_status, at))
                .collect(),
        };
        let memory_available = self.system.total_memory() > 0;
        let memory = Memory {
            total_bytes: if memory_available {
                Field::ready(self.system.total_memory(), at)
            } else {
                Field::absent(Availability::Unavailable, at)
            },
            used_bytes: if memory_available {
                Field::ready(self.system.used_memory(), at)
            } else {
                Field::absent(Availability::Unavailable, at)
            },
            available_bytes: if memory_available {
                Field::ready(self.system.available_memory(), at)
            } else {
                Field::absent(Availability::Unavailable, at)
            },
            swap_total_bytes: Field::ready(self.system.total_swap(), at),
            swap_used_bytes: Field::ready(self.system.used_swap(), at),
            swap_free_bytes: Field::ready(self.system.free_swap(), at),
        };
        let host = host::host(&self.system, at);
        (
            Snapshot {
                app_resources: demand.app_resources.then(|| self.app.latest()).flatten(),
                host,
                cpu,
                memory,
                disks,
                disks_status,
                network,
                sensors,
                sensors_status,
                sampled_at: at,
            },
            inventory,
        )
    }

    fn network(&mut self, at: SystemTime, now: Instant) -> NetworkObservation {
        let mut names = HashSet::new();
        let mut interfaces = Vec::new();
        let mut receive_total = 0.0;
        let mut transmit_total = 0.0;
        let mut ready = !self.networks.list().is_empty();
        for (name, data) in self.networks.list() {
            names.insert(name.clone());
            let rates = self.rates.entry(name.clone()).or_default();
            let received = rates.receive.sample(data.total_received(), now);
            let transmitted = rates.transmit.sample(data.total_transmitted(), now);
            if let Some(value) = received {
                receive_total += value;
            } else {
                ready = false;
            }
            if let Some(value) = transmitted {
                transmit_total += value;
            } else {
                ready = false;
            }
            interfaces.push(NetworkInterface {
                name: truncate_utf8(name, 256),
                link_state: network::link_state(data.operational_state(), at),
                mtu_bytes: network::mtu(data.mtu(), at),
                received_total_bytes: Field::ready(data.total_received(), at),
                transmitted_total_bytes: Field::ready(data.total_transmitted(), at),
                received_bytes_per_second: rate_field(received, at),
                transmitted_bytes_per_second: rate_field(transmitted, at),
                received_packets: Field::ready(data.total_packets_received(), at),
                transmitted_packets: Field::ready(data.total_packets_transmitted(), at),
                receive_errors: Field::ready(data.total_errors_on_received(), at),
                transmit_errors: Field::ready(data.total_errors_on_transmitted(), at),
            });
        }
        self.rates.retain(|name, _| names.contains(name));
        self.last_network = Some(now);
        interfaces.sort_unstable_by(|a, b| a.name.cmp(&b.name));
        let (rx, tx) = if ready {
            (
                Field::ready(receive_total, at),
                Field::ready(transmit_total, at),
            )
        } else {
            let status = if interfaces.is_empty() {
                Availability::Unavailable
            } else {
                Availability::Warming
            };
            (Field::absent(status, at), Field::absent(status, at))
        };
        NetworkObservation {
            interfaces,
            received_bytes_per_second: rx,
            transmitted_bytes_per_second: tx,
        }
    }

    fn disk_observation(&mut self, at: SystemTime, now: Instant) -> DiskObservation {
        let mut seen = HashSet::new();
        let mut aggregate = Some(0u64);
        let mut ambiguous = false;
        let mut disks = Vec::new();
        for disk in self.disks.list() {
            let mount = truncate_utf8(&disk.mount_point().to_string_lossy(), 256);
            let name = truncate_utf8(&disk.name().to_string_lossy(), 256);
            let total = disk.total_space();
            let free = disk.available_space();
            if !seen.insert((disk.name().to_os_string(), total)) {
                ambiguous = true;
                continue;
            }
            aggregate = aggregate.and_then(|value| value.checked_add(total));
            let usage = disk.usage();
            let rates = self.disk_rates.entry(name.clone()).or_default();
            let read_rate = rates.receive.sample(usage.total_read_bytes, now);
            let write_rate = rates.transmit.sample(usage.total_written_bytes, now);
            disks.push(Disk {
                name,
                mount,
                filesystem: truncate_utf8(&disk.file_system().to_string_lossy(), 256),
                total_bytes: Field::ready(total, at),
                free_bytes: Field::ready(free, at),
                used_bytes: Field::ready(total.saturating_sub(free), at),
                removable: Field::ready(disk.is_removable(), at),
                read_only: Field::ready(disk.is_read_only(), at),
                read_bytes_per_second: rate_field(read_rate, at),
                written_bytes_per_second: rate_field(write_rate, at),
            });
        }
        DiskObservation {
            aggregate_capacity_bytes: if ambiguous || disks.is_empty() {
                Field::absent(Availability::Unavailable, at)
            } else {
                optional(aggregate, at)
            },
            disks,
        }
    }

    fn sensor_observation(&self, at: SystemTime) -> Vec<Sensor> {
        self.components
            .list()
            .iter()
            .map(|component| Sensor {
                label: truncate_utf8(component.label(), 256),
                temperature_celsius: finite(component.temperature(), at),
                critical_celsius: finite(component.critical(), at),
            })
            .collect()
    }
}

fn due(last: Option<Instant>, now: Instant, interval: Duration) -> bool {
    last.is_none_or(|last| now.saturating_duration_since(last) >= interval)
}

fn rate_field(value: Option<f64>, at: SystemTime) -> Field<f64> {
    match value {
        Some(value) if value.is_finite() => Field::ready(value, at),
        _ => Field::absent(Availability::Warming, at),
    }
}

fn percent(value: f32, status: Availability, at: SystemTime) -> Field<f32> {
    if status != Availability::Ready {
        return Field::absent(status, at);
    }
    finite(Some(value.clamp(0.0, 100.0)), at)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
