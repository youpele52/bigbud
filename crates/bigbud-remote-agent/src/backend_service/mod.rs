//! Explicit account-service tooling, separate from PTY/process-operation accounting.
//! Signed provenance belongs to the verified installer which publishes the private config and
//! immutable receipt. SHA pins here establish byte identity, not independent signature trust.
mod authority;
mod cli;
mod command;
#[cfg(unix)]
#[path = "command.monitor.rs"]
mod command_monitor;
#[cfg(unix)]
#[doc(hidden)]
pub fn run_command_monitor(arguments: impl Iterator<Item = std::ffi::OsString>) -> Result<()> {
    command_monitor::run(arguments)
}
#[cfg(unix)]
#[doc(hidden)]
pub fn run_bounded_service_command(
    command: std::process::Command,
    timeout: std::time::Duration,
    maximum: usize,
    executable: &std::path::Path,
) -> Result<(String, u8)> {
    command::run_with_executable(command, timeout, maximum, executable)
}
mod config;
#[cfg(unix)]
mod lease_context;
#[cfg(unix)]
mod lease_proxy;
#[cfg(unix)]
pub use lease_context::ManagedAccountContext;
#[cfg(target_os = "linux")]
pub(crate) use lease_proxy::bounded_connect;
#[cfg(not(unix))]
pub struct ManagedAccountContext {
    _private: (),
}
mod enable;
mod explicit;
mod files;
#[cfg(unix)]
mod graph;
#[cfg(unix)]
mod launch;
mod status;
mod unit;

pub use cli::{run_cli, run_cli_with_supervisor};
pub use config::{ServiceConfig, ServiceRole};
pub use status::{Prerequisites, ServiceState, UnitStatus};
pub use unit::{UnitFiles, UnitNames, render_units};

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("account services require Linux and an unprivileged systemd user manager")]
    Unsupported,
    #[error("service startup requires explicit --confirm-startup consent")]
    ConsentRequired,
    #[error("account-service operation failed; inspect status before retrying")]
    Manager,
    #[error("account Rust supervisor failed; inspect its private logs before retrying")]
    Supervisor,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}
pub type Result<T> = std::result::Result<T, ServiceError>;

#[cfg(all(test, unix))]
mod tests;
