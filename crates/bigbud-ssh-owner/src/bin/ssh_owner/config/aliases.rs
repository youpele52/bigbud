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
    /// U17: the source line of an unknown keyword, for `IgnoreUnknown` replay.
    unknown: Option<String>,
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
    // U17: production discovery uses the same OpenSSH-style scope as admission.
    let openssh = facts.production();
    let scope = Scope::open_with(user_path, openssh)?;
    let system = system_path
        .map(|path| Scope::open_with(path, openssh))
        .transpose()?;
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
        .read(&scope, &scope.config_name()?, true, false)
        .map_err(|failure| failure.code)?;
    if let Some(system) = &system {
        discovery
            .read(system, &system.config_name()?, false, false)
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
                        unknown: (directive == Directive::Unknown).then(|| line.to_owned()),
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

#[path = "aliases.entries.rs"]
mod entries;
use entries::{concrete_alias, resolve};

#[cfg(test)]
#[path = "aliases_tests.rs"]
mod tests;
