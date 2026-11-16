mod control;
mod core;
#[cfg(target_os = "linux")]
pub(crate) use core::forward_authenticated_proxy;
#[cfg(unix)]
mod logging;

pub use control::{request_restart, request_shutdown, shutdown_response};
pub use core::{SupervisorPreparation, prepare_supervisor, run_proxy, run_supervisor};
#[cfg(unix)]
pub use logging::SupervisorLogging;
