//! Per-alias entry resolution for discovery: replay the active stanzas through
//! the shared admission `Settings` and project the result to wire metadata.

use super::*;

pub(super) fn resolve(
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
            // Same rule as admission: OpenSSH would itself ignore this keyword.
            if site
                .unknown
                .as_deref()
                .is_some_and(|line| settings.ignore_unknown.ignores(line))
            {
                continue;
            }
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

pub(super) fn concrete_alias(pattern: &str) -> bool {
    let mut bytes = pattern.bytes();
    pattern.len() <= MAX_ALIAS_NAME
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}
