//! Route family and fixed-policy restatements, split from the resolver.

use super::{Directive, ErrorCode, UNSUPPORTED};
use std::net::IpAddr;

pub(super) enum RouteFamily {
    Any,
    V4,
    V6,
}

impl RouteFamily {
    pub(super) fn is_any(&self) -> bool {
        matches!(self, Self::Any)
    }

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
        PubkeyAcceptedAlgorithms => return accepted_user_algorithms(value),
        PreferredAuthentications => return value == "publickey",
        _ => return false,
    };
    value.eq_ignore_ascii_case(expected)
}

/// U22: the user-authentication algorithms modern OpenSSH accepts by default
/// (`ssh_config(5)`, OpenSSH 10), in its order, minus SHA-1 `ssh-rsa`, DSA and
/// certificate forms (user certificates are not supported: `CertificateFile=none`).
pub(crate) const PUBKEY_ACCEPTED_ALGORITHMS: &str = concat!(
    "PubkeyAcceptedAlgorithms=",
    user_auth_core!(),
    ",",
    user_auth_security_keys!(),
    ",",
    user_auth_rsa!()
);

/// A user `PubkeyAcceptedAlgorithms` is admitted when it lists only algorithms
/// from that set: no `+`/`-`/`^` modifier, no SHA-1 `ssh-rsa`, no DSA, no
/// certificate form. The launch passes the owner's own list either way.
fn accepted_user_algorithms(value: &str) -> bool {
    let allowed = PUBKEY_ACCEPTED_ALGORITHMS
        .split_once('=')
        .map_or("", |(_, list)| list);
    !value.is_empty()
        && value.split(',').all(|algorithm| {
            !algorithm.is_empty()
                && allowed
                    .split(',')
                    .any(|known| known.eq_ignore_ascii_case(algorithm))
        })
}

/// The private launch forces GSSAPI off after every app-resolved value. Policy
/// v3 admits `GSSAPIAuthentication` only because of this override.
pub(crate) const GSSAPI_INERT_OVERRIDE: &str = "GSSAPIAuthentication=no";

/// U17: directives with no effect on destination, identity or trust under the
/// owner's launch (`ssh -F /dev/null`, every option passed explicitly, user
/// forwards never passed and `ClearAllForwardings=yes` by default; the launch
/// forces `IdentitiesOnly=yes` and `AddKeysToAgent=no` whatever the user wrote).
/// They are accepted and ignored instead of refusing the whole alias.
pub(super) fn is_inert(directive: Directive) -> bool {
    use Directive::*;
    matches!(
        directive,
        UseKeychain
            | AddKeysToAgent
            | IdentitiesOnly
            | TCPKeepAlive
            | Compression
            | LogLevel
            | VisualHostKey
            | EscapeChar
            | IPQoS
            | ConnectionAttempts
            | FingerprintHash
            | NumberOfPasswordPrompts
            | LocalForward
            | RemoteForward
            | DynamicForward
    )
}
