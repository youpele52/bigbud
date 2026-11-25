//! Route family and fixed-policy restatements, split from the resolver.

use super::{Directive, ErrorCode, UNSUPPORTED};
use std::net::IpAddr;

pub(super) enum RouteFamily {
    Any,
    V4,
    V6,
}

impl RouteFamily {
    pub(super) fn parse(value: &str) -> Result<Self, ErrorCode> {
        if value.eq_ignore_ascii_case("any") {
            Ok(Self::Any)
        } else if value.eq_ignore_ascii_case("inet") {
            Ok(Self::V4)
        } else if value.eq_ignore_ascii_case("inet6") {
            Ok(Self::V6)
        } else {
            Err(UNSUPPORTED)
        }
    }

    pub(super) fn accepts(&self, host: IpAddr) -> bool {
        matches!(
            (self, host),
            (Self::Any, _) | (Self::V4, IpAddr::V4(_)) | (Self::V6, IpAddr::V6(_))
        )
    }
}

// These settings may only restate the transport's fixed policy. Reject other
// active values even if a prior directive might shadow them in native OpenSSH.
pub(super) fn is_fixed_policy(directive: Directive, value: &str) -> bool {
    use Directive::*;
    let expected = match directive {
        BatchMode
        | ClearAllForwardings
        | IdentitiesOnly
        | PubkeyAuthentication
        | StrictHostKeyChecking => "yes",
        AddKeysToAgent
        | CanonicalizeHostname
        | CheckHostIP
        | ControlMaster
        | ControlPersist
        | ForwardAgent
        | ForwardX11
        | ForwardX11Trusted
        | HostbasedAuthentication
        | KbdInteractiveAuthentication
        | PasswordAuthentication
        | PermitLocalCommand
        | ProxyUseFdpass
        | RequestTTY
        | UpdateHostKeys
        | VerifyHostKeyDNS => "no",
        // Policy v3 (U1): the launch forces `GSSAPI_INERT_OVERRIDE` after any
        // admitted source value, so an authored `yes` is provably inert. Every
        // other GSSAPI directive remains refused.
        GSSAPIAuthentication => {
            return value.eq_ignore_ascii_case("no") || value.eq_ignore_ascii_case("yes");
        }
        CertificateFile | ControlPath | KnownHostsCommand | ProxyCommand | RemoteCommand => "none",
        PubkeyAcceptedAlgorithms => return value == "ssh-ed25519",
        PreferredAuthentications => return value == "publickey",
        _ => return false,
    };
    value.eq_ignore_ascii_case(expected)
}

/// The private launch forces GSSAPI off after every app-resolved value. Policy
/// v3 admits `GSSAPIAuthentication` only because of this override.
pub(crate) const GSSAPI_INERT_OVERRIDE: &str = "GSSAPIAuthentication=no";
