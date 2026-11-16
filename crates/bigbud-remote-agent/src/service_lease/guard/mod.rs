//! Mechanical read-only validity of caller-authorized canonical state predicates.
mod model;
mod projection;
mod read;
mod worker;
pub use model::Guard;
pub(crate) use worker::Worker;
#[cfg(test)]
mod tests;
