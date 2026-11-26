//! `IdentityFile` resolution. U17 ("like the old path"): when no host sets one,
//! the home-rooted production scope uses OpenSSH's default identities, in the
//! order of OpenSSH 10.5 (`ssh_config(5)`), keeping only keys that exist and
//! pass the owner's private-key rule (owned by the account, readable by no one
//! else, bounded). None at all is still refused; the fixture scope never
//! defaults.

use super::UNSUPPORTED;
use super::diagnostic::{ConfigDiagnostic, ConfigFailure, Directive, Located, SourceClass};
use super::paths::{self, Route};
use super::source::Scope;
use std::path::PathBuf;

const OPENSSH_DEFAULTS: [&str; 6] = [
    "~/.ssh/id_rsa",
    "~/.ssh/id_ecdsa",
    "~/.ssh/id_ecdsa_sk",
    "~/.ssh/id_ed25519",
    "~/.ssh/id_ed25519_sk",
    "~/.ssh/id_mldsa44_ed25519",
];

pub(super) fn resolve(
    configured: &[Located<String>],
    scope: &Scope,
    route: &Route<'_>,
) -> Result<Vec<Located<PathBuf>>, ConfigFailure> {
    if !configured.is_empty() {
        return configured
            .iter()
            .map(|identity| identity.try_map(|value| paths::auth_file(scope, value, route)))
            .collect();
    }
    if !scope.home_rooted() {
        return Err(UNSUPPORTED.into());
    }
    let diagnostic = ConfigDiagnostic {
        directive: Directive::IdentityFile,
        source: SourceClass::UserConfig,
        line: 0,
    };
    let found: Vec<_> = OPENSSH_DEFAULTS
        .iter()
        .filter_map(|value| {
            let path = paths::auth_file(scope, value, route).ok()?;
            scope.usable_key(&path).then_some(Located {
                value: path,
                diagnostic,
            })
        })
        .collect();
    if found.is_empty() {
        Err(UNSUPPORTED.into())
    } else {
        Ok(found)
    }
}
