//! Successor recovery for the original mobile gateway child and its controller socket.
mod decide;
#[cfg(target_os = "linux")]
mod probe;
#[cfg(not(target_os = "linux"))]
#[path = "probe.unsupported.rs"]
mod probe;
mod settle;
pub(in crate::service_lease) use settle::{attach, record, recover, release};

#[cfg(test)]
mod tests;
