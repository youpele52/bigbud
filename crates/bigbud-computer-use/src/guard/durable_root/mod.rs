//! Descriptor-owned macOS durable election root. Separate from transient sockets.
//! No hostile-root/arbitrary-same-UID isolation is claimed. Name revalidation
//! detects observed replacement, not an atomic defense against such attackers.
mod account;
mod layout;
mod root;
#[cfg(test)]
mod tests;

pub use layout::RootLayout;
pub use root::DurableRoot;
