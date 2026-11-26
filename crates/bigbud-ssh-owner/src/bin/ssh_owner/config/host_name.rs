//! The one host rule shared by alias policy (`HostName`) and production target
//! descriptors: an IP literal or an RFC 1123 DNS name. A name is never resolved
//! here; the owner resolves it at target-binding time and checks host keys
//! against the name, as OpenSSH does.

use super::{
    ConfigFailure, ErrorCode, Located, diagnostic::ConfigDiagnostic, fixed_policy::RouteFamily,
};
use std::net::IpAddr;

pub(crate) const MAX_HOST: usize = 253;
const MAX_LABEL: usize = 63;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Host {
    Ip(IpAddr),
    Name(String),
}

impl PartialEq<IpAddr> for Host {
    fn eq(&self, other: &IpAddr) -> bool {
        self.ip() == Some(*other)
    }
}

impl std::fmt::Display for Host {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ip(ip) => ip.fmt(formatter),
            Self::Name(name) => formatter.write_str(name),
        }
    }
}

impl Host {
    /// A non-unspecified IP literal, or dot-separated labels of 1–63 ASCII
    /// letters, digits or hyphens with no leading or trailing hyphen and at most
    /// 253 bytes. An all-numeric final label would read as a malformed IPv4
    /// literal and is refused.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        if let Ok(ip) = value.parse::<IpAddr>() {
            return (!ip.is_unspecified()).then_some(Self::Ip(ip));
        }
        let label = |label: &str| {
            !label.is_empty()
                && label.len() <= MAX_LABEL
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        };
        let numeric_tail = value
            .rsplit('.')
            .next()
            .is_some_and(|tail| tail.bytes().all(|b| b.is_ascii_digit()));
        (value.len() <= MAX_HOST && !numeric_tail && value.split('.').all(label))
            .then(|| Self::Name(value.to_owned()))
    }

    /// The literal address, or `None` for a name that is not yet resolved.
    pub(crate) fn ip(&self) -> Option<IpAddr> {
        match self {
            Self::Ip(ip) => Some(*ip),
            Self::Name(_) => None,
        }
    }

    pub(crate) fn name(&self) -> Option<&str> {
        match self {
            Self::Name(name) => Some(name),
            Self::Ip(_) => None,
        }
    }

    /// The known-hosts name OpenSSH checks for this host without a
    /// `HostKeyAlias`: the name itself on port 22, `[name]:port` otherwise.
    pub(crate) fn known_hosts_label(name: &str, port: u16) -> String {
        if port == 22 {
            name.to_owned()
        } else {
            format!("[{name}]:{port}")
        }
    }
}

/// Admits a policy `HostName`. Fixture routes stay numeric loopback; production
/// also admits a DNS name, which cannot satisfy an explicit `AddressFamily`
/// before the owner resolves it.
pub(super) fn admit(
    value: &str,
    host: Option<&ConfigDiagnostic>,
    family: Option<&Located<RouteFamily>>,
    allow_non_loopback: bool,
) -> Result<Host, ConfigFailure> {
    const UNSUPPORTED: ErrorCode = ErrorCode::ConfigUnsupported;
    let reject = || host.map_or(UNSUPPORTED.into(), |host| host.reject(UNSUPPORTED));
    let parsed = Host::parse(value).ok_or_else(reject)?;
    let accepted = match &parsed {
        Host::Ip(ip) if !allow_non_loopback && !ip.is_loopback() => return Err(reject()),
        Host::Name(_) if !allow_non_loopback => return Err(reject()),
        Host::Ip(ip) => family.is_none_or(|family| family.value.accepts(*ip)),
        Host::Name(_) => family.is_none_or(|family| family.value.is_any()),
    };
    if accepted {
        Ok(parsed)
    } else {
        Err(family.map_or(UNSUPPORTED.into(), |family| {
            family.diagnostic.reject(UNSUPPORTED)
        }))
    }
}
