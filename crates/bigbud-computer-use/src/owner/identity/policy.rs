use super::verified::{
    FileIdentity, IdentitySource, VerifiedApp, file_identity, inside_app_bundle,
    valid_bundle_identifier,
};
use crate::owner::{
    admission::policy_canonical::AppSelector,
    mediation::egress::{AppPolicy, AppVerdict},
};
use std::{
    num::NonZeroU32,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityPolicyError {
    /// A selector the owner cannot verify on this platform. Refusing the whole
    /// policy is safer than silently ignoring a user restriction.
    Unsupported {
        kind: String,
    },
    Invalid,
}

/// Built-in hard blocks that no grant waives (e.g. bigbud's own host
/// processes and Stop/policy surfaces).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HardBlocks {
    pub bundle_identifiers: Vec<String>,
    pub pids: Vec<NonZeroU32>,
}

/// One `path` selector, resolved once at compile time. Matches the lexical
/// value, its canonical (symlink-resolved) form, or the same filesystem
/// object under any name. A path that does not exist yet keeps its lexical
/// rule only, so a restriction on a not-yet-installed app still applies.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PathRule {
    lexical: PathBuf,
    canonical: Option<PathBuf>,
    file: Option<FileIdentity>,
}
impl PathRule {
    fn compile(value: &str) -> Option<Self> {
        let normalized = value.len() > 1
            && value.starts_with('/')
            && value
                .split('/')
                .skip(1)
                .all(|part| !matches!(part, "" | "." | ".."));
        normalized.then(|| Self {
            lexical: PathBuf::from(value),
            canonical: std::fs::canonicalize(value).ok(),
            file: file_identity(Path::new(value)),
        })
    }
    fn matches(&self, path: &Path, file: Option<FileIdentity>) -> bool {
        path == self.lexical
            || self.canonical.as_deref() == Some(path)
            || file.is_some_and(|file| self.file == Some(file))
    }
}

/// Compiled macOS selectors: default grant, minus user disallows, minus hard
/// blocks. Bundle identifiers compare ASCII-case-insensitively (Launch
/// Services treats them so). `path` selectors must be normalized absolute
/// paths (no `.`, `..`, empty components or trailing `/`) and are resolved at
/// compile time; compiling therefore reads filesystem metadata.
///
/// Anything inside an `.app` bundle that cannot be attributed to a valid
/// bundle identifier is `Unverified`, never `Permitted`: otherwise a
/// bundle-id restriction (including a hard block) would be bypassed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityPolicy {
    bundle_identifiers: Vec<String>,
    paths: Vec<PathRule>,
    hard: HardBlocks,
}

impl IdentityPolicy {
    pub fn compile(
        selectors: &[AppSelector],
        hard: HardBlocks,
    ) -> Result<Self, IdentityPolicyError> {
        let mut policy = Self {
            bundle_identifiers: Vec::new(),
            paths: Vec::new(),
            hard,
        };
        for selector in selectors {
            match (selector.platform.as_str(), selector.kind.as_str()) {
                ("macos", "bundle_id") if valid_bundle_identifier(&selector.value) => {
                    policy
                        .bundle_identifiers
                        .push(selector.value.to_ascii_lowercase());
                }
                ("macos", "path") => {
                    let rule =
                        PathRule::compile(&selector.value).ok_or(IdentityPolicyError::Invalid)?;
                    policy.paths.push(rule);
                }
                ("macos", "bundle_id") => return Err(IdentityPolicyError::Invalid),
                // Selectors for other platforms never match a macOS process.
                ("windows" | "linux", _) => {}
                (_, kind) => {
                    return Err(IdentityPolicyError::Unsupported {
                        kind: kind.to_owned(),
                    });
                }
            }
        }
        Ok(policy)
    }

    pub fn verdict(&self, app: &VerifiedApp) -> AppVerdict {
        let identifier = app
            .bundle
            .as_ref()
            .and_then(|bundle| bundle.identifier.as_deref())
            .map(str::to_ascii_lowercase);
        let hard = self.hard.pids.contains(&app.pid)
            || identifier.as_ref().is_some_and(|id| {
                self.hard
                    .bundle_identifiers
                    .iter()
                    .any(|blocked| blocked.eq_ignore_ascii_case(id))
            });
        let by_identifier = identifier
            .as_ref()
            .is_some_and(|id| self.bundle_identifiers.contains(id));
        let by_path = self.paths.iter().any(|rule| {
            rule.matches(&app.executable, app.executable_file)
                || app
                    .bundle
                    .as_ref()
                    .is_some_and(|bundle| rule.matches(&bundle.path, bundle.file))
        });
        let unattributed = match &app.bundle {
            Some(bundle) => bundle.identifier.is_none(),
            None => inside_app_bundle(&app.executable),
        };
        if hard || by_identifier || by_path {
            AppVerdict::Disallowed
        } else if unattributed {
            AppVerdict::Unverified
        } else {
            AppVerdict::Permitted
        }
    }
}

/// `AppPolicy` for egress: resolves each pid through the verified source;
/// any resolution failure is `Unverified` (excluded), never `Permitted`.
pub struct IdentityAppPolicy<S: IdentitySource> {
    pub source: S,
    pub policy: IdentityPolicy,
}

impl<S: IdentitySource> AppPolicy for IdentityAppPolicy<S> {
    fn verdict(&self, pid: u32) -> AppVerdict {
        let Some(pid) = NonZeroU32::new(pid) else {
            return AppVerdict::Unverified;
        };
        match self.source.resolve(pid) {
            Ok(app) => self.policy.verdict(&app),
            Err(_) => AppVerdict::Unverified,
        }
    }
}
