use super::TransportConfig;
use std::{net::Ipv4Addr, path::Path};

// A generic --workspace-root is not eligibility for normal-dev readiness.
// Match the generated fixture's owner lock, identity, pins and workspace.
// Transport binding already requires a private, owner-controlled pins directory.
pub(super) fn matches_fixture(config: &TransportConfig, lock: &Path) -> bool {
    let Some(root) = config.identity.parent() else {
        return false;
    };
    config.host == Ipv4Addr::LOCALHOST
        && config.port >= 1024
        && config.identity == root.join("identity")
        && config.known_hosts == root.join("known_hosts")
        && lock == root.join("owner.lock")
        && config.workspace_root.as_deref()
            == Some(root.join("home/picker's folders; literal").as_path())
        && config.system_config.is_none()
        && matches_platform_fixture(config, root)
}

#[cfg(target_os = "macos")]
fn matches_platform_fixture(config: &TransportConfig, root: &Path) -> bool {
    super::posix_picker::is_disposable_root(root)
        && config.dev_interactive_terminal
        && config
            .alias_config
            .as_ref()
            .is_none_or(|(file, _)| file == &root.join("owner-alias.conf"))
}

#[cfg(target_os = "linux")]
fn matches_platform_fixture(config: &TransportConfig, root: &Path) -> bool {
    super::posix_picker::is_linux_disposable_root(root)
        && config.port == 22222
        && config.user == "picker"
        && !config.dev_interactive_terminal
        && config.alias_config.is_none()
}

#[cfg(test)]
#[path = "workspace_readiness.tests.rs"]
mod tests;

/// Fixture-only readiness/snapshot selection, kept out of `bootstrap`.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[allow(clippy::too_many_arguments)]
pub(super) fn fixture_selection(
    config: &TransportConfig,
    lock: &Path,
    attach: bool,
    identity_agent: bool,
    agent_fixture: bool,
    stage: bool,
    snapshot_cancel: bool,
) -> (bool, bool) {
    let readiness =
        !attach && !identity_agent && !agent_fixture && !stage && matches_fixture(config, lock);
    let snapshot_only =
        cfg!(target_os = "macos") && snapshot_cancel && !config.dev_interactive_terminal;
    (readiness, snapshot_only)
}
