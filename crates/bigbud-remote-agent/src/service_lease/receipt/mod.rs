//! Durable original-child readiness receipt bound to the attempt, authority and CAS lineage.
mod model;
mod store;
pub(in crate::service_lease) use model::{
    Listener, Receipt, SocketIdentity, Upstream, upstream_argument,
};
pub(in crate::service_lease) use store::Store;

#[cfg(test)]
mod tests;
