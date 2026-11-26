//! Which name a target's host key is checked under (OpenSSH semantics).
//!
//! The transport always dials the address in `TransportConfig::host`. When the
//! target was named by DNS, known-hosts lookups, approvals and the SSH
//! `HostKeyAlias` use the name (or an explicit alias), never the address the
//! owner resolved, so a user's name-keyed `known_hosts` keeps verifying.

use crate::config::Host;
use std::net::IpAddr;

/// Host-key naming facts carried beside the dialled address.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HostIdentity {
    /// The DNS name the target was configured with, if it was named.
    pub(crate) dns_name: Option<String>,
    /// An explicit known-hosts name (descriptor `host_key_alias`).
    pub(crate) key_alias: Option<String>,
}

impl HostIdentity {
    /// Precedence: policy `HostKeyAlias`, then this identity's explicit alias,
    /// then the name's own known-hosts label, then the scanned address label.
    pub(super) fn label(&self, policy_alias: Option<&str>, port: u16, scan_label: &str) -> String {
        if let Some(alias) = policy_alias.or(self.key_alias.as_deref()) {
            return alias.to_owned();
        }
        match &self.dns_name {
            Some(name) => Host::known_hosts_label(name, port),
            None => scan_label.to_owned(),
        }
    }

    /// Whether a re-read policy host still names this exact target: a name
    /// compares with the configured name, an address with the dialled address.
    pub(super) fn matches(&self, policy: &Host, dialled: IpAddr) -> bool {
        match policy {
            Host::Ip(ip) => self.dns_name.is_none() && *ip == dialled,
            Host::Name(name) => self.dns_name.as_deref() == Some(name.as_str()),
        }
    }
}

#[cfg(test)]
#[path = "host_identity.tests.rs"]
mod tests;
