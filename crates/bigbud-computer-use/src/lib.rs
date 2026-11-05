//! Dormant computer-use ownership foundations. No constructor starts processes,
//! listeners, threads or a runtime. This crate is not selected by Electron.
//! File durability, process containment and platform controls remain unqualified;
//! the executable refuses activation until the complete system is implemented.
pub mod broker;
pub mod guard;
#[cfg(target_os = "macos")]
mod native_fs;
pub mod owner;
pub mod roles;
mod sha256;
pub mod worker;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Guard,
    Owner,
    Worker,
    Broker,
}

impl Role {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "guard" => Some(Self::Guard),
            "owner" => Some(Self::Owner),
            "worker" => Some(Self::Worker),
            "broker" => Some(Self::Broker),
            _ => None,
        }
    }
}
