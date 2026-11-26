//! S1 Unix loopback proof only, not an ambient OpenSSH config reader.
//!
//! Only explicit synthetic sources are read: user first, then optional system.
//! Each source has its own private fixture root for active Include operands,
//! including nested Includes. On macOS/Linux, globs admit `*`, `?` and simple
//! ASCII bracket classes with bytewise ordering. An empty glob is allowed; a
//! missing literal is not. Included files, traversed directories and the system
//! top-level file must be owner-private; no symlinks below either root. The
//! user top-level file retains its existing owner-only write policy.
//! `~/` means `<user fixture>/home/` for user Includes and for identity/trust
//! files from either source. System Includes cannot use `~`; relative Includes
//! keep their declaring fixture root (the synthetic user/system Include base).
//! IdentityFile and UserKnownHostsFile must resolve to private siblings of the
//! user config or private files under the synthetic home.
//! `HostName %h` uses the original alias. `%h/%n/%p/%r` use the route so far
//! for Include and the final route for key and trust files. Only Include admits
//! a literal `%` from `%%`: auth paths would be re-expanded by transport, and
//! the destination must be a numeric loopback address. No `~user`,
//! environment or other substitutions, brace expansion, hostname passes,
//! or proxy. IdentityFile entries are additive in either source; agent use
//! requires an explicitly scoped socket or a trusted fixture startup hint.
//! Trust lists remain fixture-only; only the first user file is an approval
//! destination. Transport enforces the supported host-record types.

pub(super) mod aliases;
pub(super) mod connector;
mod descriptor;
pub(super) mod diagnostic;
mod fixed_policy;
mod fixture_fs;
pub(crate) mod host_name;
mod host_verification;
mod identities;
mod identity_agent;
mod ignore_unknown;
mod include;
pub(super) mod jump;
mod paths;
mod route_facts;
mod send_env;
mod source;
mod startup;
mod syntax;
mod timers;
mod trust_paths;

#[cfg(test)]
mod tests;

use super::v1::ErrorCode;
use connector::ConnectorProgram;
use diagnostic::{ConfigDiagnostic, ConfigFailure, Directive, Located};
pub(crate) use fixed_policy::{GSSAPI_INERT_OVERRIDE, PUBKEY_ACCEPTED_ALGORITHMS};
use fixed_policy::{RouteFamily, is_fixed_policy, is_inert};
pub(crate) use host_name::Host;
pub(super) use host_verification::HostVerification;
use identity_agent::AgentSetting;
pub(super) use identity_agent::IdentityAgent;
pub(super) use route_facts::{LocalAccountFact, RouteFacts, RouteOverrides};
use send_env::SendEnv;
use source::{Scope, SourceToken};
#[cfg(test)]
use std::net::IpAddr;
use std::num::NonZeroU16;
use std::path::{Path, PathBuf};
use syntax::safe_host;
pub(crate) use syntax::safe_token;
pub(super) use timers::SshTimers;
use trust_paths::TrustSettings;

const UNSUPPORTED: ErrorCode = ErrorCode::ConfigUnsupported;
const MAX_IDENTITIES: usize = 16;

pub(super) fn valid_configured_trust_path(path: &Path) -> bool {
    paths::literal_parent(path, true).is_ok()
}

pub(super) struct ResolvedConfig {
    /// `HostName` as configured: an IP literal or a DNS name the owner
    /// resolves at binding time (production only).
    pub host: Host,
    pub port: u16,
    pub user: String,
    pub identity: PathBuf,
    pub additional_identities: Vec<PathBuf>,
    pub identity_agent: IdentityAgent,
    pub known_hosts: Option<PathBuf>,
    pub additional_user_known_hosts: Vec<PathBuf>,
    pub global_known_hosts: Vec<PathBuf>,
    pub host_key_alias: Option<String>,
    pub host_verification: HostVerification,
    pub hash_known_hosts: bool,
    pub send_env: SendEnv,
    pub timers: SshTimers,
    /// Restricted `nc %h %p` connector, or `None` for a direct route.
    pub connector: Option<ConnectorProgram>,
    source: SourceToken,
    #[cfg(any(test, target_os = "linux"))]
    jump: Option<Located<Vec<jump::Hop>>>,
}

impl ResolvedConfig {
    pub(super) fn revalidate(&self) -> Result<(), ErrorCode> {
        self.source.revalidate()
    }
}

#[cfg(test)]
pub(super) fn resolve(
    path: &Path,
    alias: &str,
    local_user: &str,
) -> Result<ResolvedConfig, ErrorCode> {
    resolve_with_diagnostic(path, None, alias, Some(local_user)).map_err(|failure| failure.code)
}

#[cfg(test)]
pub(super) fn resolve_with_system(
    path: &Path,
    system_path: &Path,
    alias: &str,
    local_user: &str,
) -> Result<ResolvedConfig, ErrorCode> {
    resolve_with_diagnostic(path, Some(system_path), alias, Some(local_user))
        .map_err(|failure| failure.code)
}

/// Resolve an explicit startup alias, reporting policy rejection only on stderr.
/// Do not use this for revalidation or repeated operations.
pub(super) fn resolve_for_startup(
    path: &Path,
    system_path: Option<&Path>,
    alias: &str,
    facts: &RouteFacts,
    allow_non_loopback: bool,
) -> Result<ResolvedConfig, ErrorCode> {
    resolve_with_facts(path, system_path, alias, facts, allow_non_loopback)
        .map_err(|failure| startup::report_rejection(failure, std::io::stderr().lock()))
}

#[cfg(test)]
fn resolve_with_diagnostic(
    path: &Path,
    system_path: Option<&Path>,
    alias: &str,
    local_user: Option<&str>,
) -> Result<ResolvedConfig, ConfigFailure> {
    let account = local_user
        .map(|name| LocalAccountFact::new(501, name))
        .transpose()?;
    resolve_with_facts(
        path,
        system_path,
        alias,
        &RouteFacts::new(account, RouteOverrides::default()),
        false,
    )
}

pub(super) fn resolve_with_facts(
    path: &Path,
    system_path: Option<&Path>,
    alias: &str,
    facts: &RouteFacts,
    allow_non_loopback: bool,
) -> Result<ResolvedConfig, ConfigFailure> {
    if !safe_host(alias) {
        return Err(UNSUPPORTED.into());
    }
    // U17: production admission follows OpenSSH's own permission checks.
    let openssh = facts.production();
    let scope = Scope::open_with(path, openssh)?;
    let system = system_path
        .map(|path| Scope::open_with(path, openssh))
        .transpose()?;
    let (settings, config) = include::evaluate(&scope, system.as_ref(), alias, facts)?;
    let route = settings.route(alias, facts);
    let host = host_name::admit(
        route.host,
        settings.host.as_ref().map(|host| &host.diagnostic),
        settings.address_family.as_ref(),
        allow_non_loopback,
    )?;
    let user = route.user.ok_or(UNSUPPORTED)?;
    let identities = identities::resolve(&settings.identities, &scope, &route)?;
    let identity_agent = AgentSetting::resolve(settings.identity_agent.as_ref(), &scope, &route)?;
    let trust = settings.trust.resolve(&scope, system.as_ref(), &route)?;
    let host_verification = settings.host_verification.as_ref();
    if let Some(algorithm) = host_verification
        && algorithm.value == HostVerification::Ed25519Certificate
        && (settings.host_key_alias.is_none() || !trust.user.is_empty())
    {
        return Err(algorithm.diagnostic.reject(UNSUPPORTED));
    }
    let source = scope.bind(system, config, alias, facts, &identities, &trust)?;
    let mut identities = identities.into_iter().map(|identity| identity.value);
    let mut user_known_hosts = trust.user.into_iter().map(|path| path.value);
    Ok(ResolvedConfig {
        host,
        port: route.port,
        user: user.to_owned(),
        identity: identities.next().ok_or(UNSUPPORTED)?,
        additional_identities: identities.collect(),
        identity_agent,
        known_hosts: user_known_hosts.next(),
        additional_user_known_hosts: user_known_hosts.collect(),
        global_known_hosts: trust
            .global
            .into_iter()
            .map(|entry| entry.path.value)
            .collect(),
        host_key_alias: settings.host_key_alias,
        host_verification: host_verification
            .map_or_else(HostVerification::default, |entry| entry.value),
        hash_known_hosts: settings.hash_known_hosts.unwrap_or(false),
        send_env: settings.send_env,
        timers: settings.timers,
        connector: settings.connector.and_then(|connector| connector.value),
        source,
        #[cfg(any(test, target_os = "linux"))]
        jump: settings.jump,
    })
}

#[derive(Default)]
struct Settings {
    host: Option<Located<String>>,
    port: Option<NonZeroU16>,
    address_family: Option<Located<RouteFamily>>,
    user: Option<String>,
    identities: Vec<Located<String>>,
    identity_agent: Option<Located<AgentSetting>>,
    trust: TrustSettings,
    host_key_alias: Option<String>,
    host_verification: Option<Located<HostVerification>>,
    hash_known_hosts: Option<bool>,
    send_env: SendEnv,
    timers: SshTimers,
    connector: Option<Located<Option<ConnectorProgram>>>,
    #[cfg(any(test, target_os = "linux"))]
    jump: Option<Located<Vec<jump::Hop>>>,
    #[cfg(any(test, target_os = "linux"))]
    proxy_command: Option<ConfigDiagnostic>,
    ignore_unknown: ignore_unknown::IgnoreUnknown,
}

impl Settings {
    /// Apply one directive that is active for `alias`. Include/scope control is
    /// the caller's responsibility; this is shared by admission and discovery so
    /// both observe the same first-value-wins policy.
    pub(super) fn apply_directive(
        &mut self,
        diagnostic: ConfigDiagnostic,
        args: &mut syntax::Tokens<'_>,
        alias: &str,
        facts: &RouteFacts,
    ) -> Result<(), ConfigFailure> {
        use Directive::*;
        let _ = facts;
        let reject = |code| diagnostic.reject(code);
        match diagnostic.directive {
            SendEnv => self.send_env.add(*args).map_err(reject),
            ProxyJump => {
                let value = args.one().map_err(reject)?;
                #[cfg(any(test, target_os = "linux"))]
                if facts.allow_jump {
                    let route = jump::parse_route(value, diagnostic)?;
                    self.jump.get_or_insert(Located {
                        value: route,
                        diagnostic,
                    });
                    return Ok(());
                }
                jump::enforce_disabled(value, diagnostic)
            }
            UserKnownHostsFile | GlobalKnownHostsFile => {
                self.trust.set(diagnostic, *args).map_err(reject)
            }
            ProxyCommand => self.apply(diagnostic, args.raw(), alias).map_err(reject),
            IgnoreUnknown => {
                self.ignore_unknown.set(args.raw());
                Ok(())
            }
            directive if is_inert(directive) => Ok(()),
            Host | Match | Include => Err(diagnostic.reject(UNSUPPORTED)),
            _ => self
                .apply(diagnostic, args.one().map_err(reject)?, alias)
                .map_err(reject),
        }
    }

    fn route<'a>(&'a self, alias: &'a str, facts: &'a RouteFacts) -> paths::Route<'a> {
        // Explicit trusted fields win from the first line onward. Next come
        // the first active config values so far, then local fixture defaults.
        // Host selectors and %n still take the original alias independently.
        let explicit = &facts.overrides;
        paths::Route {
            host: explicit
                .host
                .as_deref()
                .or_else(|| self.host.as_ref().map(|host| host.value.as_str()))
                .unwrap_or(alias),
            alias,
            port: explicit.port.or(self.port).map_or(22, NonZeroU16::get),
            user: explicit
                .user
                .as_deref()
                .or(self.user.as_deref())
                .or_else(|| facts.local_user()),
        }
    }

    fn apply(
        &mut self,
        diagnostic: ConfigDiagnostic,
        value: &str,
        alias: &str,
    ) -> Result<(), ErrorCode> {
        use Directive::*;
        match diagnostic.directive {
            HostName => {
                self.host.get_or_insert(Located {
                    value: paths::hostname(value, alias)?,
                    diagnostic,
                });
            }
            Port if value.bytes().all(|byte| byte.is_ascii_digit()) => {
                self.port
                    .get_or_insert(value.parse().map_err(|_| UNSUPPORTED)?);
            }
            AddressFamily => {
                self.address_family.get_or_insert(Located {
                    value: RouteFamily::parse(value)?,
                    diagnostic,
                });
            }
            User if safe_token(value, 64) => {
                self.user.get_or_insert_with(|| value.to_owned());
            }
            HostKeyAlias if safe_token(value, 255) => {
                self.host_key_alias
                    .get_or_insert_with(|| value.to_ascii_lowercase());
            }
            HostKeyAlgorithms => {
                let value = HostVerification::parse(value)?;
                self.host_verification
                    .get_or_insert(Located { value, diagnostic });
            }
            HashKnownHosts => {
                let enabled = match value {
                    value if value.eq_ignore_ascii_case("yes") => true,
                    value if value.eq_ignore_ascii_case("no") => false,
                    _ => return Err(UNSUPPORTED),
                };
                self.hash_known_hosts.get_or_insert(enabled);
            }
            IdentityAgent => {
                let setting = AgentSetting::parse(value)?;
                self.identity_agent.get_or_insert(Located {
                    value: setting,
                    diagnostic,
                });
            }
            IdentityFile => {
                paths::validate_auth_operand(value)?;
                // OpenSSH keeps the first occurrence of each unexpanded operand.
                if !self
                    .identities
                    .iter()
                    .any(|identity| identity.value == value)
                {
                    if self.identities.len() >= MAX_IDENTITIES {
                        return Err(UNSUPPORTED);
                    }
                    self.identities.push(Located {
                        value: value.to_owned(),
                        diagnostic,
                    });
                }
            }
            ProxyCommand => {
                // First value wins, as in OpenSSH; any active value conflicts with a jump.
                let value = ConnectorProgram::parse(value)?;
                #[cfg(any(test, target_os = "linux"))]
                self.proxy_command.get_or_insert(diagnostic);
                self.connector.get_or_insert(Located { value, diagnostic });
            }
            ConnectTimeout => SshTimers::set(&mut self.timers.connect, value)?,
            ServerAliveInterval => SshTimers::set(&mut self.timers.interval, value)?,
            ServerAliveCountMax => SshTimers::set(&mut self.timers.count, value)?,
            directive if is_fixed_policy(directive, value) => {}
            _ => return Err(UNSUPPORTED),
        }
        Ok(())
    }
}
