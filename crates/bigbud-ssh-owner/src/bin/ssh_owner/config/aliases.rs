//! Bounded, read-only discovery of concrete aliases in the owner's own config.
//!
//! Discovery parses the same owner-private sources as admission, follows the
//! same literal include grammar and applies the same first-value-wins settings.
//! It never spawns, dials, resolves DNS or evaluates a `Match` criterion: any
//! non-`all` `Match` is reported as a per-alias unsupported policy. Each alias
//! receives its own resolved route metadata and, when its policy cannot be
//! admitted, a typed redacted refusal instead of failing the whole list.

use super::diagnostic::{ConfigDiagnostic, ConfigFailure, Directive, SourceClass};
use super::include::{MAX_INCLUDE_DEPTH, MAX_INCLUDE_FILES, expand};
use super::paths::{Route, include_path};
use super::source::{FileId, Scope};
use super::syntax::{Tokens, host_matches};
use super::{RouteFacts, Settings, UNSUPPORTED};
use crate::v1::{AliasRouteKind, ErrorCode, ProofAliasEntry, ProofAliasUnsupported, ProofAliases};
use std::collections::HashSet;
use std::path::Path;

/// Hard bound on reported aliases. Parsing still validates the remainder and
/// sets `truncated` instead of silently growing the response.
pub(super) const MAX_ALIASES: usize = 256;
/// Mirrors the TypeScript resolver's alias alphabet bound.
pub(super) const MAX_ALIAS_NAME: usize = 64;
/// Parser-owned metadata is already smaller; this is the final wire bound.
pub(super) const MAX_METADATA: usize = 255;
const MAX_WORK: usize = 65_536;

struct AliasName {
    name: String,
    source: SourceClass,
    line: usize,
}

struct DirectiveSite {
    raw: String,
    diagnostic: ConfigDiagnostic,
}

struct Stanza {
    patterns: Patterns,
    directives: Vec<DirectiveSite>,
}

enum Patterns {
    /// Global scope or an admitted `Match all` block.
    Global,
    /// Re-tokenized `Host` patterns.
    Host(String),
    /// A non-`all` `Match` block: never entered and never evaluated.
    Refused,
}

struct Discovery {
    stanzas: Vec<Stanza>,
    aliases: Vec<AliasName>,
    alias_names: HashSet<String>,
    truncated: bool,
    match_refusal: Option<ConfigDiagnostic>,
    stack: Vec<FileId>,
    files: usize,
    work: usize,
}

/// Discover alias metadata from the owner's bound user config and optional
/// system config. `ConfigUnsupported` is returned for an oversized or malformed
/// config; individual policy refusals live on their own entries.
pub(crate) fn list(
    user_path: &Path,
    system_path: Option<&Path>,
    facts: &RouteFacts,
) -> Result<ProofAliases, ErrorCode> {
    let scope = Scope::open(user_path)?;
    let system = system_path.map(Scope::open).transpose()?;
    let mut discovery = Discovery {
        stanzas: vec![Stanza {
            patterns: Patterns::Global,
            directives: Vec::new(),
        }],
        aliases: Vec::new(),
        alias_names: HashSet::new(),
        truncated: false,
        match_refusal: None,
        stack: Vec::new(),
        files: 0,
        work: MAX_WORK,
    };
    discovery
        .read(&scope, Path::new(scope.config_name()?), true, false)
        .map_err(|failure| failure.code)?;
    if let Some(system) = &system {
        discovery
            .read(system, Path::new(system.config_name()?), false, false)
            .map_err(|failure| failure.code)?;
    }
    let entries = resolve(&discovery, facts).map_err(|failure| failure.code)?;
    Ok(ProofAliases {
        entries,
        truncated: discovery.truncated,
        max_entries: MAX_ALIASES as u32,
    })
}

impl Discovery {
    fn read(
        &mut self,
        scope: &Scope,
        path: &Path,
        user_source: bool,
        included: bool,
    ) -> Result<(), ConfigFailure> {
        if self.stack.len() > MAX_INCLUDE_DEPTH || self.files >= MAX_INCLUDE_FILES {
            return Err(UNSUPPORTED.into());
        }
        let private = !user_source || included;
        let (version, bytes) = scope.read_config(path, private)?;
        let id = version.id();
        if self.stack.contains(&id) {
            return Err(UNSUPPORTED.into());
        }
        self.stack.push(id);
        self.files += 1;
        let text = std::str::from_utf8(&bytes).map_err(|_| UNSUPPORTED)?;
        let source = match (user_source, included) {
            (true, false) => SourceClass::UserConfig,
            (true, true) => SourceClass::UserInclude,
            (false, false) => SourceClass::SystemConfig,
            (false, true) => SourceClass::SystemInclude,
        };
        self.parse(scope, text, source, user_source)?;
        self.stack.pop();
        Ok(())
    }

    fn parse(
        &mut self,
        scope: &Scope,
        text: &str,
        source: SourceClass,
        user_source: bool,
    ) -> Result<(), ConfigFailure> {
        let mut current = 0;
        for (index, line) in text.lines().enumerate() {
            let Some((directive, args)) =
                Tokens::directive(line).map_err(|_| ConfigFailure::from(UNSUPPORTED))?
            else {
                continue;
            };
            let diagnostic = ConfigDiagnostic {
                directive,
                source,
                line: index + 1,
            };
            match directive {
                Directive::Host => {
                    let raw = args.raw().to_owned();
                    self.record_aliases(&raw, diagnostic)?;
                    self.stanzas.push(Stanza {
                        patterns: Patterns::Host(raw),
                        directives: Vec::new(),
                    });
                    current = self.stanzas.len() - 1;
                }
                Directive::Match => {
                    let raw = args.raw();
                    if raw.trim().eq_ignore_ascii_case("all") {
                        self.stanzas.push(Stanza {
                            patterns: Patterns::Global,
                            directives: Vec::new(),
                        });
                    } else {
                        self.match_refusal.get_or_insert(diagnostic);
                        self.stanzas.push(Stanza {
                            patterns: Patterns::Refused,
                            directives: Vec::new(),
                        });
                    }
                    current = self.stanzas.len() - 1;
                }
                Directive::Include => {
                    self.read_include(scope, args.raw(), diagnostic, user_source)?;
                    current = self.stanzas.len() - 1;
                }
                _ => {
                    let site = DirectiveSite {
                        raw: args.raw().to_owned(),
                        diagnostic,
                    };
                    self.stanzas
                        .get_mut(current)
                        .ok_or_else(|| ConfigFailure::from(UNSUPPORTED))?
                        .directives
                        .push(site);
                }
            }
        }
        Ok(())
    }

    fn record_aliases(
        &mut self,
        raw: &str,
        diagnostic: ConfigDiagnostic,
    ) -> Result<(), ConfigFailure> {
        let mut patterns = Tokens::new(raw);
        while let Some(pattern) = patterns.next().map_err(|code| diagnostic.reject(code))? {
            if !concrete_alias(pattern) {
                continue;
            }
            if self.alias_names.contains(pattern) {
                continue;
            }
            if self.aliases.len() >= MAX_ALIASES {
                self.truncated = true;
                continue;
            }
            self.alias_names.insert(pattern.to_owned());
            self.aliases.push(AliasName {
                name: pattern.to_owned(),
                source: diagnostic.source,
                line: diagnostic.line,
            });
        }
        // Reject an out-of-alphabet `Host` pattern instead of silently
        // treating it as an empty or broader selector.
        let mut check = Tokens::new(raw);
        while let Some(pattern) = check.next().map_err(|code| diagnostic.reject(code))? {
            host_matches(&mut Tokens::new(pattern), "probe")
                .map_err(|code| diagnostic.reject(code))?;
        }
        Ok(())
    }

    fn read_include(
        &mut self,
        scope: &Scope,
        raw: &str,
        diagnostic: ConfigDiagnostic,
        user_source: bool,
    ) -> Result<(), ConfigFailure> {
        let mut args = Tokens::new(raw);
        let mut operand = args
            .next()
            .map_err(|code| diagnostic.reject(code))?
            .ok_or_else(|| diagnostic.reject(UNSUPPORTED))?;
        loop {
            self.spend(diagnostic)?;
            // Discovery is alias-independent, so an operand that needs `%`
            // substitution cannot be resolved without evaluating admission.
            if operand.contains('%') || operand.contains("${") {
                return Err(diagnostic.reject(UNSUPPORTED));
            }
            let route = Route {
                host: "",
                alias: "",
                port: 22,
                user: None,
            };
            let relative = include_path(scope, operand, &route, user_source)
                .map_err(|code| diagnostic.reject(code))?;
            let matches = expand(
                scope,
                &relative,
                MAX_INCLUDE_FILES - self.files,
                &mut self.work,
            )
            .map_err(|code| diagnostic.reject(code))?;
            for path in matches {
                self.read(scope, &path, user_source, true)?;
            }
            match args.next().map_err(|code| diagnostic.reject(code))? {
                Some(next) => operand = next,
                None => return Ok(()),
            }
        }
    }

    fn spend(&mut self, diagnostic: ConfigDiagnostic) -> Result<(), ConfigFailure> {
        self.work = self
            .work
            .checked_sub(1)
            .ok_or_else(|| diagnostic.reject(UNSUPPORTED))?;
        Ok(())
    }
}

fn resolve(
    discovery: &Discovery,
    facts: &RouteFacts,
) -> Result<Vec<ProofAliasEntry>, ConfigFailure> {
    discovery
        .aliases
        .iter()
        .map(|alias| resolve_one(discovery, facts, alias))
        .collect()
}

fn resolve_one(
    discovery: &Discovery,
    facts: &RouteFacts,
    alias: &AliasName,
) -> Result<ProofAliasEntry, ConfigFailure> {
    let mut settings = Settings::default();
    let mut refusal: Option<ConfigDiagnostic> = None;
    'stanzas: for stanza in &discovery.stanzas {
        let active = match &stanza.patterns {
            Patterns::Global => true,
            Patterns::Refused => false,
            Patterns::Host(raw) => {
                host_matches(&mut Tokens::new(raw), &alias.name).map_err(|code| {
                    ConfigDiagnostic {
                        directive: Directive::Host,
                        source: alias.source,
                        line: alias.line,
                    }
                    .reject(code)
                })?
            }
        };
        if !active {
            continue;
        }
        for site in &stanza.directives {
            if let Err(failure) = settings.apply_directive(
                site.diagnostic,
                &mut Tokens::new(&site.raw),
                &alias.name,
                facts,
            ) {
                refusal = Some(failure.diagnostic.unwrap_or(site.diagnostic));
                break 'stanzas;
            }
        }
    }
    let route = settings.route(&alias.name, facts);
    let unsupported = refusal.or(discovery.match_refusal);
    entry(alias, &settings, route, unsupported)
}

fn entry(
    alias: &AliasName,
    settings: &Settings,
    route: Route<'_>,
    unsupported: Option<ConfigDiagnostic>,
) -> Result<ProofAliasEntry, ConfigFailure> {
    #[cfg(any(test, target_os = "linux"))]
    let jump_hops = settings
        .jump
        .as_ref()
        .map_or(0, |jump| jump.value.len() as u32);
    #[cfg(not(any(test, target_os = "linux")))]
    let jump_hops = 0_u32;
    let route_kind = if jump_hops > 0 {
        AliasRouteKind::Jump
    } else if settings
        .connector
        .as_ref()
        .is_some_and(|connector| connector.value.is_some())
    {
        AliasRouteKind::RestrictedConnector
    } else {
        AliasRouteKind::Direct
    };
    let metadata = |value: &str| -> Result<String, ConfigFailure> {
        if value.len() > MAX_METADATA {
            return Err(UNSUPPORTED.into());
        }
        Ok(value.to_owned())
    };
    Ok(ProofAliasEntry {
        alias: metadata(&alias.name)?,
        host_name: metadata(route.host)?,
        port: u32::from(route.port),
        user: metadata(route.user.unwrap_or(""))?,
        host_key_alias: metadata(settings.host_key_alias.as_deref().unwrap_or(""))?,
        route_kind: route_kind as i32,
        jump_hops,
        source: alias.source.identifier().to_owned(),
        line: alias.line as u32,
        unsupported: unsupported.map(|site| ProofAliasUnsupported {
            reason: site.directive.identifier().to_ascii_lowercase(),
            remedy: site.remedy().to_owned(),
            source: site.source.identifier().to_owned(),
            line: site.line as u32,
        }),
    })
}

fn concrete_alias(pattern: &str) -> bool {
    let mut bytes = pattern.bytes();
    pattern.len() <= MAX_ALIAS_NAME
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

#[cfg(test)]
#[path = "aliases_tests.rs"]
mod tests;
