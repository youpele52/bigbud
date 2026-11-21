mod control;
mod core;
#[cfg(target_os = "linux")]
pub(crate) use core::forward_authenticated_proxy;
#[cfg(unix)]
mod logging;

pub(crate) use control::register_exit_receipt;
pub use control::{request_restart, request_shutdown, shutdown_response};
#[cfg(unix)]
pub use core::{SupervisorOptions, daemonize::detach_from_launcher, run_supervisor_with};
pub use core::{SupervisorPreparation, prepare_supervisor, run_proxy, run_supervisor};
#[cfg(unix)]
pub use logging::SupervisorLogging;
