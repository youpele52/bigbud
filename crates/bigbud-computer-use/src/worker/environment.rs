//! Native worker launch environment construction only. No process is started.
//! Callers must supply guard-owned, verified managed paths and immutable tuple
//! policy/host identity; these strings do not verify filesystem/code identity.
use std::{
    collections::BTreeMap,
    path::{Component, Path},
};

const REQUIRED: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_CURRENT_DESKTOP",
    "DESKTOP_SESSION",
];
const MAX_ENTRIES: usize = 64;
const MAX_BYTES: usize = 64 * 1024;

pub struct ManagedEnvironment<'a> {
    pub home: &'a Path,
    pub policy: &'a Path,
    pub endpoint: &'a Path,
    pub host_bundle_id: &'a str,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvironmentError {
    InvalidManagedIdentity,
    Limit,
}
fn path(value: &Path) -> Result<&str, EnvironmentError> {
    if !value.is_absolute()
        || value
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(EnvironmentError::InvalidManagedIdentity);
    }
    value
        .to_str()
        .filter(|value| value.len() <= 4096 && !value.contains('\0'))
        .ok_or(EnvironmentError::InvalidManagedIdentity)
}

/// Mirrors the existing first-party child-environment allow set, then stamps
/// managed safety fields LAST. No provider/API credential, arbitrary CUA option,
/// standalone history/config home or model-selected override is inherited.
/// Compatible legacy home aliases still require pinned-source validation before
/// actual bootstrap; do not infer that setting an unused alias isolates state.
pub fn build_environment<'a>(
    source: impl IntoIterator<Item = (&'a str, &'a str)>,
    managed: ManagedEnvironment<'_>,
) -> Result<BTreeMap<String, String>, EnvironmentError> {
    let home = path(managed.home)?;
    let policy = path(managed.policy)?;
    let endpoint = path(managed.endpoint)?;
    if managed.host_bundle_id.is_empty()
        || managed.host_bundle_id.len() > 128
        || !managed
            .host_bundle_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
    {
        return Err(EnvironmentError::InvalidManagedIdentity);
    }
    let mut environment = BTreeMap::new();
    let mut bytes = 0_usize;
    for (key, value) in source {
        if !REQUIRED.contains(&key) && !key.starts_with("LC_") {
            continue;
        }
        if key.len() > 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || value.len() > 4096
            || value.contains('\0')
        {
            return Err(EnvironmentError::Limit);
        }
        // Duplicates are refused, not silently ordered overrides.
        if environment.contains_key(key) {
            return Err(EnvironmentError::InvalidManagedIdentity);
        }
        bytes = bytes
            .checked_add(key.len() + value.len())
            .ok_or(EnvironmentError::Limit)?;
        if bytes > MAX_BYTES || environment.len() >= MAX_ENTRIES {
            return Err(EnvironmentError::Limit);
        }
        environment.insert(key.into(), value.into());
    }
    for (key, value) in [
        ("CUA_DRIVER_RS_HOME", home),
        ("CUA_DRIVER_POLICY_FILE", policy),
        ("CUA_DRIVER_RS_TELEMETRY_ENABLED", "false"),
        ("CUA_DRIVER_RS_UPDATE_CHECK", "false"),
        ("CUA_DRIVER_ALLOW_BRIEF_FOREGROUND", "false"),
        ("CUA_DRIVER_EMBEDDED", "1"),
        ("CUA_DRIVER_HOST_BUNDLE_ID", managed.host_bundle_id),
        ("CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS", "300"),
        ("CUA_DRIVER_RS_RECORDING_IDLE_TTL_SECS", "60"),
        ("BIGBUD_CUA_ENDPOINT", endpoint),
        ("BIGBUD_CUA_DRIVER_SOCKET", endpoint),
        ("BIGBUD_CUA_HOST_BUNDLE_ID", managed.host_bundle_id),
    ] {
        bytes = bytes
            .checked_add(key.len() + value.len())
            .ok_or(EnvironmentError::Limit)?;
        if bytes > MAX_BYTES || environment.len() >= MAX_ENTRIES {
            return Err(EnvironmentError::Limit);
        }
        environment.insert(key.into(), value.into());
    }
    Ok(environment)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn managed() -> ManagedEnvironment<'static> {
        ManagedEnvironment {
            home: Path::new("/managed/home"),
            policy: Path::new("/managed/policy"),
            endpoint: Path::new("/managed/socket"),
            host_bundle_id: "ai.bigbud.desktop",
        }
    }
    #[test]
    fn isolates_driver_state_without_inheriting_credentials_or_cua_overrides() {
        let result = build_environment(
            [
                ("HOME", "/user"),
                ("DISPLAY", ":0"),
                ("OPENAI_API_KEY", "secret"),
                ("CUA_DRIVER_RS_HOME", "/standalone"),
                ("CUA_DRIVER_ALLOW_BRIEF_FOREGROUND", "true"),
                ("LC_ALL", "en_US.UTF-8"),
            ],
            managed(),
        )
        .unwrap();
        assert_eq!(result.get("CUA_DRIVER_RS_HOME").unwrap(), "/managed/home");
        assert_eq!(
            result.get("CUA_DRIVER_ALLOW_BRIEF_FOREGROUND").unwrap(),
            "false"
        );
        assert_eq!(
            result.get("CUA_DRIVER_RS_TELEMETRY_ENABLED").unwrap(),
            "false"
        );
        assert_eq!(result.get("CUA_DRIVER_RS_UPDATE_CHECK").unwrap(), "false");
        assert_eq!(result.get("HOME").unwrap(), "/user");
        assert_eq!(result.get("DISPLAY").unwrap(), ":0");
        assert!(!result.contains_key("OPENAI_API_KEY"));
    }
    #[test]
    fn invalid_paths_host_and_duplicate_values_refuse_without_launch() {
        assert!(
            build_environment(
                [],
                ManagedEnvironment {
                    home: Path::new("relative"),
                    ..managed()
                }
            )
            .is_err()
        );
        assert!(
            build_environment(
                [],
                ManagedEnvironment {
                    home: Path::new("/managed/../outside"),
                    ..managed()
                }
            )
            .is_err()
        );
        assert!(
            build_environment(
                [],
                ManagedEnvironment {
                    host_bundle_id: "bad\0host",
                    ..managed()
                }
            )
            .is_err()
        );
        assert!(build_environment([("HOME", "/a"), ("HOME", "/b")], managed()).is_err());
    }
    #[test]
    fn bounds_inherited_and_stamped_environment_in_aggregate() {
        let entries: Vec<_> = (0..64)
            .map(|index| (format!("LC_{index}"), "x".repeat(4096)))
            .collect();
        assert_eq!(
            build_environment(
                entries
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
                managed()
            ),
            Err(EnvironmentError::Limit)
        );
        assert_eq!(
            build_environment([("LANG", "bad\0value")], managed()),
            Err(EnvironmentError::Limit)
        );
    }
}
