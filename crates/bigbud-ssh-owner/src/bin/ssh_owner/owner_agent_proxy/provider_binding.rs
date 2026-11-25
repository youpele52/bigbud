use std::{
    io,
    path::{Path, PathBuf},
    time::Duration,
};

use super::{
    AgentProxyFixture, AgentProxyLease, ErrorCode, Transport, adopt_pipes, codex, pi,
    provider_service, v1,
};
use crate::Token;

#[derive(Clone, Copy)]
pub(in super::super) enum ProviderKind {
    Codex,
    Pi,
}

enum Recipe {
    Codex(codex::Recipe),
    Pi(pi::Recipe),
    /// Product service: the executable and workspace are owner-selected at startup.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Service(provider_service::Recipe),
}

pub(super) struct ProviderBinding {
    recipe: Recipe,
    probed_generation: Option<Token>,
}

impl AgentProxyFixture {
    /// # Safety
    /// One exact startup caller transfers the three live byte descriptors.
    pub(in super::super) unsafe fn new_provider(
        kind: ProviderKind,
        scope: v1::ProofProviderScope,
        sha256: String,
    ) -> io::Result<Self> {
        let binary = PathBuf::from(scope.binary);
        let cwd = Path::new(&scope.cwd);
        let thread = &scope.thread_id;
        let epoch = scope.session_epoch;
        let recipe = match kind {
            ProviderKind::Codex => {
                Recipe::Codex(codex::Recipe::new(&binary, &sha256, cwd, thread, epoch)?)
            }
            ProviderKind::Pi => Recipe::Pi(pi::Recipe::new(&binary, &sha256, cwd, thread, epoch)?),
        };
        // SAFETY: these descriptor ends are exclusively transferred by startup.
        let pipes = unsafe { adopt_pipes([3, 4, 5]) }?;
        Ok(Self {
            binary,
            sha256,
            pipes: Some(pipes),
            installed: None,
            scoped: None,
            relay: None,
            provider: Some(ProviderBinding {
                recipe,
                probed_generation: None,
            }),
        })
    }

    /// # Safety
    /// One exact startup caller transfers the three live byte descriptors.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(in super::super) unsafe fn new_provider_service(
        kind: provider_service::Kind,
        binary: &Path,
        root: &Path,
    ) -> io::Result<Self> {
        let recipe = provider_service::Recipe::new(kind, binary, root)?;
        // SAFETY: these descriptor ends are exclusively transferred by startup.
        let pipes = unsafe { adopt_pipes([3, 4, 5]) }?;
        Ok(Self {
            binary: binary.to_path_buf(),
            sha256: String::new(),
            pipes: Some(pipes),
            installed: None,
            scoped: None,
            relay: None,
            provider: Some(ProviderBinding {
                recipe: Recipe::Service(recipe),
                probed_generation: None,
            }),
        })
    }

    pub(in super::super) fn probe_provider(
        &mut self,
        transport: &Transport,
        kind: ProviderKind,
        scope: &v1::ProofProviderScope,
        generation: Token,
    ) -> Result<v1::ProofProviderVersion, ErrorCode> {
        let provider = self.provider.as_mut().ok_or(ErrorCode::OperationDenied)?;
        if self.pipes.is_none() || !provider.recipe.matches(kind, scope, &self.sha256) {
            return Err(ErrorCode::OperationDenied);
        }
        provider.probed_generation = None;
        let (command, timeout, limit) = match &provider.recipe {
            Recipe::Codex(recipe) => (
                recipe.probe_command().to_owned(),
                Duration::from_secs(18),
                1024 * 1024,
            ),
            // Leave headroom for the dispatcher/client 5 second deadline.
            Recipe::Pi(recipe) => (
                recipe.probe_command().to_owned(),
                Duration::from_secs(4),
                4096,
            ),
            Recipe::Service(recipe) => {
                let (timeout, limit) = match recipe.kind() {
                    provider_service::Kind::Codex => (Duration::from_secs(18), 1024 * 1024),
                    provider_service::Kind::Pi => (Duration::from_secs(4), 4096),
                };
                (recipe.probe_command(), timeout, limit)
            }
        };
        let result = transport.probe_bound_provider(&command, timeout, limit)?;
        if result.code == Some(0) && recognized_version(kind, &result.stdout) {
            provider.probed_generation = Some(generation);
        }
        Ok(result)
    }

    pub(in super::super) fn open_provider(
        &mut self,
        transport: &Transport,
        kind: ProviderKind,
        scope: &v1::ProofProviderScope,
        generation: Token,
    ) -> Result<AgentProxyLease, ErrorCode> {
        let provider = self.provider.as_ref().ok_or(ErrorCode::OperationDenied)?;
        if self.pipes.is_none()
            || provider.probed_generation != Some(generation)
            || !provider.recipe.matches(kind, scope, &self.sha256)
        {
            return Err(ErrorCode::OperationDenied);
        }
        let command = match &provider.recipe {
            Recipe::Codex(recipe) => recipe.command().to_owned(),
            Recipe::Pi(recipe) => recipe.command().to_owned(),
            Recipe::Service(recipe) => recipe.command(scope),
        };
        self.launch(transport, &command)
    }
}

impl Recipe {
    fn matches(&self, kind: ProviderKind, scope: &v1::ProofProviderScope, sha: &str) -> bool {
        match (self, kind) {
            (Self::Codex(recipe), ProviderKind::Codex) => {
                scope.session_file.is_none()
                    && recipe.matches_binding(
                        &scope.binary,
                        sha,
                        &scope.cwd,
                        &scope.thread_id,
                        scope.session_epoch,
                    )
            }
            (Self::Pi(recipe), ProviderKind::Pi) => recipe.matches_binding(
                &scope.binary,
                sha,
                &scope.cwd,
                &scope.thread_id,
                scope.session_epoch,
                scope.session_file.as_deref(),
            ),
            (Self::Service(recipe), ProviderKind::Codex) => {
                recipe.kind() == provider_service::Kind::Codex && recipe.matches(scope)
            }
            (Self::Service(recipe), ProviderKind::Pi) => {
                recipe.kind() == provider_service::Kind::Pi && recipe.matches(scope)
            }
            _ => false,
        }
    }
}

fn recognized_version(kind: ProviderKind, stdout: &str) -> bool {
    let text = stdout.trim_end();
    let version = match kind {
        ProviderKind::Codex => match text.strip_prefix("codex-cli ") {
            Some(version) => version,
            None => return false,
        },
        ProviderKind::Pi => text
            .strip_prefix("pi v")
            .or_else(|| text.strip_prefix("pi "))
            .unwrap_or(text),
    };
    let mut parts = version.split('.');
    (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u32>().is_ok()
        })
    }) && parts.next().is_none()
}

#[cfg(test)]
#[test]
fn only_a_numeric_release_in_the_exact_provider_vocabulary_can_arm_a_start() {
    assert!(recognized_version(
        ProviderKind::Codex,
        "codex-cli 0.166.0\n"
    ));
    assert!(recognized_version(ProviderKind::Pi, "0.99.0\n"));
    assert!(recognized_version(ProviderKind::Pi, "pi v0.99.0\n"));
    for invalid in [
        "codex-cli unknown",
        "codex-cli 0.166",
        "codex-cli 0.166.0-alpha.1",
        "codex-cli 0.166.0\nother",
        "codex-cli 0.+166.0",
        "codex-cli 0.166.999999999999",
        "pi v0.99.0",
    ] {
        assert!(!recognized_version(ProviderKind::Codex, invalid));
    }
    assert!(!recognized_version(ProviderKind::Pi, "codex-cli 0.166.0"));
}
