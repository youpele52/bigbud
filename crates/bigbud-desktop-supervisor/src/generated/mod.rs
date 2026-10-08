pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.desktop_supervisor.v1.rs"));
}

mod system_monitor {
    pub mod metrics {
        pub mod v1 {
            include!(concat!(
                env!("OUT_DIR"),
                "/bigbud.system_monitor.metrics.v1.rs"
            ));
        }
    }
    pub mod app {
        pub mod v1 {
            include!(concat!(env!("OUT_DIR"), "/bigbud.system_monitor.app.v1.rs"));
        }
    }
    pub mod process {
        pub mod v1 {
            include!(concat!(
                env!("OUT_DIR"),
                "/bigbud.system_monitor.process.v1.rs"
            ));
        }
    }
    pub mod v1 {
        include!(concat!(env!("OUT_DIR"), "/bigbud.system_monitor.v1.rs"));
        pub use super::app::v1::{AppGroup, AppProcessRoot, AppResources};
        pub use super::metrics::v1::Metric;
        pub use super::process::v1::{ProcessPage, ProcessRow};
    }
}
pub use system_monitor::v1 as monitor_v1;
