use super::*;
use crate::model::{Host, HostIdentity};

pub fn identity() -> HostIdentity {
    HostIdentity {
        hostname: System::host_name(),
        os_name: System::name(),
        os_version: System::long_os_version(),
        architecture: Some(System::cpu_arch()),
    }
}

pub(super) fn host(system: &System, at: SystemTime) -> Host {
    let cpu = system.cpus().first();
    let load_average = if cfg!(windows) {
        Field::absent(Availability::Unsupported, at)
    } else {
        let load = System::load_average();
        Field::ready([load.one, load.five, load.fifteen], at)
    };
    Host {
        hostname: optional(System::host_name(), at),
        os_name: optional(System::name(), at),
        os_version: optional(System::long_os_version(), at),
        kernel_version: optional(System::kernel_version(), at),
        architecture: Field::ready(System::cpu_arch(), at),
        uptime_seconds: Field::ready(System::uptime(), at),
        boot_time_seconds: Field::ready(System::boot_time(), at),
        physical_cores: optional(System::physical_core_count(), at),
        logical_cores: optional(
            (!system.cpus().is_empty()).then_some(system.cpus().len()),
            at,
        ),
        cpu_brand: optional(cpu.map(|cpu| cpu.brand().to_owned()), at),
        cpu_frequency_mhz: optional(cpu.map(|cpu| cpu.frequency()), at),
        load_average,
    }
}
