pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.desktop_supervisor.v1.rs"));
}

pub mod monitor_v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.system_monitor.v1.rs"));
}
