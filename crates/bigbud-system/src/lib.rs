//! Read-only local host resource observations. Collection starts only when explicitly sampled.

pub mod app_resources;
pub mod collector;
pub mod inventory;
mod observation;
mod service;

pub use observation::{model, rate};
pub use service::{lifecycle, recovery};
