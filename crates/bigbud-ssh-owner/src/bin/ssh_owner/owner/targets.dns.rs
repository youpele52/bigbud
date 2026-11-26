//! Owner-side DNS for target descriptors that name their host.
//!
//! Lookups are bounded: the system resolver runs on a helper thread and a
//! lookup that misses its deadline is a typed refusal, never a hang inside
//! admission. Nothing is cached here; callers resolve on every binding.

use std::{
    net::{IpAddr, ToSocketAddrs},
    sync::mpsc,
    time::Duration,
};

const LOOKUP_DEADLINE: Duration = Duration::from_secs(5);

/// Resolves one host name to the first usable address, or `None`.
pub(crate) trait HostResolver: Send + Sync {
    fn resolve(&self, name: &str, port: u16) -> Option<IpAddr>;
}

pub(super) struct SystemResolver;

impl HostResolver for SystemResolver {
    fn resolve(&self, name: &str, port: u16) -> Option<IpAddr> {
        let (sender, receiver) = mpsc::sync_channel(1);
        let query = (name.to_owned(), port);
        std::thread::Builder::new()
            .name("ssh-owner-dns".into())
            .spawn(move || {
                let first = query
                    .to_socket_addrs()
                    .ok()
                    .and_then(|mut addresses| {
                        addresses.find(|address| !address.ip().is_unspecified())
                    })
                    .map(|address| address.ip());
                let _ = sender.send(first);
            })
            .ok()?;
        receiver.recv_timeout(LOOKUP_DEADLINE).ok().flatten()
    }
}
