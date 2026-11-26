//! Bounded ProxyJump preflight. Transport stays closed until each hop can
//! resolve, verify its own trust, and forward to the next pinned endpoint.

#[cfg(any(test, target_os = "linux"))]
use super::{
    HostVerification, IdentityAgent, ResolvedConfig, RouteFacts, RouteOverrides, resolve_with_facts,
};
use super::{
    UNSUPPORTED,
    diagnostic::{ConfigDiagnostic, ConfigFailure},
    syntax::{safe_host, safe_token},
};
#[cfg(any(test, target_os = "linux"))]
use std::{collections::HashSet, path::Path};
use std::{net::Ipv6Addr, num::NonZeroU16};

const MAX_HOPS: usize = 4;

pub(super) fn enforce_disabled(value: &str, site: ConfigDiagnostic) -> Result<(), ConfigFailure> {
    if parse_route(value, site)?.is_empty() {
        Ok(())
    } else {
        Err(site.reject(UNSUPPORTED))
    }
}

pub(super) fn parse_route(value: &str, site: ConfigDiagnostic) -> Result<Vec<Hop>, ConfigFailure> {
    if value.eq_ignore_ascii_case("none") {
        return Ok(Vec::new());
    }
    let mut preceding = Vec::with_capacity(MAX_HOPS);
    for (index, value) in value.split(',').enumerate() {
        let position = index + 1;
        let hop = parse_hop(value).filter(|hop| !preceding.contains(hop));
        match hop {
            Some(hop) if position <= MAX_HOPS => preceding.push(hop),
            _ => return Err(site.reject(UNSUPPORTED).at_jump_hop(position)),
        }
    }
    Ok(preceding)
}

#[derive(PartialEq, Eq, Debug)]
pub(super) struct Hop {
    user: Option<String>,
    host: String,
    port: Option<NonZeroU16>,
}

#[cfg(any(test, target_os = "linux"))]
impl Hop {
    /// Canonical operand for the alias descriptor digest; no OpenSSH formatting.
    pub(super) fn write_descriptor(&self, write: &mut impl FnMut(&[u8])) {
        write(self.user.as_deref().unwrap_or("").as_bytes());
        write(self.host.as_bytes());
        write(&self.port.map_or(0, NonZeroU16::get).to_be_bytes());
    }
}

fn parse_hop(value: &str) -> Option<Hop> {
    let (user, address) = match value.split_once('@') {
        Some((user, address)) if safe_token(user, 64) => (Some(user.to_owned()), address),
        Some(_) => return None,
        None => (None, value),
    };
    let (host, port) = if let Some(bracketed) = address.strip_prefix('[') {
        let (host, suffix) = bracketed.split_once(']')?;
        let host = host.parse::<Ipv6Addr>().ok()?.to_string();
        let port = if suffix.is_empty() {
            None
        } else {
            Some(parse_port(suffix.strip_prefix(':')?)?)
        };
        (host, port)
    } else if let Ok(host) = address.parse::<Ipv6Addr>() {
        (host.to_string(), None)
    } else if let Some((host, port)) = address.split_once(':') {
        if !safe_host(host) {
            return None;
        }
        (host.to_ascii_lowercase(), Some(parse_port(port)?))
    } else if safe_host(address) {
        (address.to_ascii_lowercase(), None)
    } else {
        return None;
    };
    Some(Hop { user, host, port })
}

fn parse_port(port: &str) -> Option<NonZeroU16> {
    if port.is_empty() || port.len() > 5 || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

#[cfg(any(test, target_os = "linux"))]
pub(super) fn check_proxy_conflict(settings: &super::Settings) -> Result<(), ConfigFailure> {
    if let Some(site) = settings.proxy_command
        && settings
            .jump
            .as_ref()
            .is_some_and(|jump| !jump.value.is_empty())
    {
        return Err(site.reject(UNSUPPORTED));
    }
    Ok(())
}

#[cfg(any(test, target_os = "linux"))]
pub(crate) fn resolve_chain(
    path: &Path,
    system: Option<&Path>,
    alias: &str,
    mut facts: RouteFacts,
) -> Result<Vec<ResolvedConfig>, ConfigFailure> {
    facts.allow_jump = true;
    let destination = resolve_with_facts(path, system, alias, &facts, false)?;
    let Some(route) = &destination.jump else {
        return Err(UNSUPPORTED.into());
    };
    if route.value.is_empty() {
        return Err(route.diagnostic.reject(UNSUPPORTED));
    }
    let mut endpoints = HashSet::from([(destination.host.clone(), destination.port)]);
    let mut aliases = HashSet::from([alias.to_ascii_lowercase()]);
    let mut legs = Vec::with_capacity(route.value.len() + 1);
    for (index, hop) in route.value.iter().enumerate() {
        let reject = |code| route.diagnostic.reject(code).at_jump_hop(index + 1);
        if !aliases.insert(hop.host.clone()) {
            return Err(reject(UNSUPPORTED));
        }
        let overrides = RouteOverrides::new(None, hop.user.as_deref(), hop.port).map_err(reject)?;
        let leg = resolve_with_facts(path, system, &hop.host, &facts.for_hop(overrides), false)
            .map_err(|failure| failure.at_jump_hop(index + 1))?;
        if !endpoints.insert((leg.host.clone(), leg.port)) || !key_only(&leg) {
            return Err(reject(UNSUPPORTED));
        }
        legs.push(leg);
    }
    if !key_only(&destination) {
        return Err(route.diagnostic.reject(UNSUPPORTED));
    }
    legs.push(destination);
    Ok(legs)
}

#[cfg(any(test, target_os = "linux"))]
fn key_only(leg: &ResolvedConfig) -> bool {
    leg.host_verification == HostVerification::Ed25519Key
        && matches!(
            leg.identity_agent,
            IdentityAgent::Absent | IdentityAgent::Disabled
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::diagnostic::{Directive, SourceClass};

    const SITE: ConfigDiagnostic = ConfigDiagnostic {
        directive: Directive::ProxyJump,
        source: SourceClass::UserConfig,
        line: 7,
    };

    #[test]
    fn bounded_key_jump_operands_are_parsed_without_admitting_transport() {
        assert!(enforce_disabled("NoNe", SITE).is_ok());
        let failure = enforce_disabled("a,bob@b:2200,[::1]:2201,::2", SITE).unwrap_err();
        assert_eq!(failure.code, UNSUPPORTED);
        assert_eq!(failure.jump_hop, None);
        assert_eq!(
            parse_hop("alice@[0:0:0:0:0:0:0:1]:22").unwrap(),
            Hop {
                user: Some("alice".into()),
                host: "::1".into(),
                port: NonZeroU16::new(22),
            }
        );
    }

    #[test]
    fn reports_the_ordinal_of_the_first_malformed_duplicate_or_excess_hop() {
        for (route, position) in [
            ("a,b:0", 2),
            ("a,user@@b", 2),
            ("a,[::1]:65536", 2),
            ("a,b;marker", 2),
            ("a,,b", 2),
            ("a,b,A", 3),
            ("[::1]:22,b,[0:0:0:0:0:0:0:1]:22", 3),
            ("a,b,c,d,e", 5),
        ] {
            let failure = enforce_disabled(route, SITE).unwrap_err();
            assert_eq!(failure.jump_hop, Some(position), "{route}");
            assert_eq!(failure.diagnostic.unwrap().line, SITE.line);
        }
    }
}
