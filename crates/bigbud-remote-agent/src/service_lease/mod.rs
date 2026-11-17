//! Managed-account execution capability; application activation belongs to TypeScript.
#[cfg(unix)]
mod assets;
#[cfg(unix)]
mod bridge;
#[cfg(unix)]
mod guard;
#[cfg(unix)]
pub use assets::Resource as AssetsResource;
mod identity;
#[cfg(unix)]
pub use guard::Guard;
#[cfg(unix)]
mod protocol;
#[cfg(unix)]
#[path = "protocol.validate.rs"]
mod protocol_validate;
#[cfg(unix)]
mod retention;
#[cfg(unix)]
pub(crate) use bridge::Bridge;
#[cfg(unix)]
pub(crate) use protocol::is_request;
#[cfg(unix)]
mod peer;
#[cfg(unix)]
pub use peer::Peer;
#[cfg(unix)]
mod owner;
#[cfg(unix)]
mod process;
#[cfg(unix)]
mod receipt;
#[cfg(unix)]
mod recovery;

pub use identity::{Binding, Controller};
#[cfg(unix)]
pub use owner::{Generation, Grant, LeaseOwner, Snapshot, State};
#[cfg(unix)]
pub use process::{Launch, SecretEnvironment};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("service lease input is invalid")]
    Invalid,
    #[error("service lease ownership was refused")]
    Refused,
    #[error("service lease capacity is occupied")]
    Occupied,
    #[error("service lease execution requires repair")]
    Uncertain,
    #[error("service leases require the managed Linux account owner")]
    Unsupported,
    #[error("service lease private IO failed")]
    Io(#[from] std::io::Error),
}
pub type Result<A> = std::result::Result<A, Error>;

/// Private same-executable worker, invoked only with an inherited owner socket.
#[cfg(unix)]
pub fn run_monitor() -> Result<()> {
    process::run_monitor()
}

#[cfg(test)]
mod tests;
