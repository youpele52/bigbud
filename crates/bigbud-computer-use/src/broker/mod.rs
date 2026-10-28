//! Launch broker (M1/M3.launch), run as its own role OUTSIDE execution
//! containment (no Job/process group of the worker), so launched user apps
//! survive Stop. It maps only trusted OS identities, never model-chosen
//! paths/argv/environment; it owns only tracked launches and has no kill API.
//! The OS backends (macOS NSWorkspace, Windows CreateProcessW/AUMID/ProgID,
//! Linux GIO/D-Bus) need unapproved framework/library linkage and refuse.
mod request;
mod service;
#[cfg(test)]
mod tests;

pub use request::{AppIdentity, BrokerRequest, HttpUrl, UrlError};
pub use service::{
    Broker, BrokerOutcome, LaunchBackend, LaunchFailure, Launched, UnavailableBackend,
};
