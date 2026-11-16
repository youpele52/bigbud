use super::{Result, ServiceError, files};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceRole {
    Backend,
    Rust,
}

#[cfg(all(test, unix))]
#[path = "config.path.tests.rs"]
mod path_tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceConfig {
    pub authority: String,
    pub home: PathBuf,
    pub backend_home: PathBuf,
    pub rust_binary: PathBuf,
    pub rust_sha256: String,
    pub rust_state: PathBuf,
    pub node_binary: PathBuf,
    pub node_sha256: String,
    pub backend_entry: PathBuf,
    pub backend_sha256: String,
    pub receipt_sha256: String,
    pub restart: bool,
    pub launch_attempt: String,
    pub prior_epoch: String,
    pub launch_boot: String,
    pub expected_installation_fingerprint: String,
    pub authority_reservation_sha256: String,
}

fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl ServiceConfig {
    pub fn config_dir(&self) -> PathBuf {
        self.home
            .join(".bigbud/backend-services")
            .join(&self.authority)
    }
    pub fn config_path(&self) -> PathBuf {
        self.config_dir().join("config-v1")
    }
    pub fn token_path(&self) -> PathBuf {
        self.config_dir().join("client-token")
    }
    pub fn receipt_path(&self) -> PathBuf {
        self.config_dir().join("artifact-receipt")
    }

    pub fn parse(text: &str) -> Result<Self> {
        if text.len() > 32 * 1024 {
            return Err(ServiceError::Invalid("service config is oversized"));
        }
        let mut values = BTreeMap::new();
        for line in text.lines() {
            let (key, value) = line
                .split_once('=')
                .ok_or(ServiceError::Invalid("malformed service config"))?;
            if key.is_empty()
                || value.is_empty()
                || value.chars().any(char::is_control)
                || values.insert(key, value).is_some()
            {
                return Err(ServiceError::Invalid(
                    "invalid or duplicate service config field",
                ));
            }
        }
        if values.len() != 18 || values.get("version") != Some(&"1") {
            return Err(ServiceError::Invalid(
                "unsupported service config version or fields",
            ));
        }
        let field = |name| {
            values
                .get(name)
                .copied()
                .ok_or(ServiceError::Invalid("missing service config field"))
        };
        let restart = match field("restart")? {
            "yes" => true,
            "no" => false,
            _ => return Err(ServiceError::Invalid("invalid restart policy")),
        };
        let config = Self {
            authority: field("authority")?.into(),
            home: field("home")?.into(),
            backend_home: field("backend_home")?.into(),
            rust_binary: field("rust_binary")?.into(),
            rust_sha256: field("rust_sha256")?.into(),
            rust_state: field("rust_state")?.into(),
            node_binary: field("node_binary")?.into(),
            node_sha256: field("node_sha256")?.into(),
            backend_entry: field("backend_entry")?.into(),
            backend_sha256: field("backend_sha256")?.into(),
            receipt_sha256: field("receipt_sha256")?.into(),
            restart,
            launch_attempt: field("launch_attempt")?.into(),
            prior_epoch: field("prior_epoch")?.into(),
            launch_boot: field("launch_boot")?.into(),
            expected_installation_fingerprint: field("expected_installation_fingerprint")?.into(),
            authority_reservation_sha256: field("authority_reservation_sha256")?.into(),
        };
        if !valid_hex(&config.authority, 32)
            || [
                &config.rust_sha256,
                &config.node_sha256,
                &config.backend_sha256,
                &config.receipt_sha256,
                &config.authority_reservation_sha256,
            ]
            .iter()
            .any(|value| !valid_hex(value, 64))
        {
            return Err(ServiceError::Invalid(
                "invalid authority or artifact digest",
            ));
        }
        if config
            .expected_installation_fingerprint
            .strip_prefix("sha256:")
            .is_none_or(|value| !valid_hex(value, 64))
        {
            return Err(ServiceError::Invalid(
                "invalid expected backend installation fingerprint",
            ));
        }
        Ok(config)
    }

    pub(super) fn definition(path: &Path) -> Result<Self> {
        let bytes = files::read_private(path, 32 * 1024)?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| ServiceError::Invalid("service config must be UTF-8"))?;
        let config = Self::parse(text)?;
        if path != config.config_path() {
            return Err(ServiceError::Invalid(
                "service config must use its stable account path",
            ));
        }
        Ok(config)
    }

    pub fn load(path: &Path) -> Result<Self> {
        let config = Self::definition(path)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        self.validate_role(ServiceRole::Backend)
    }

    pub(super) fn validate_role(&self, role: ServiceRole) -> Result<()> {
        if !valid_hex(&self.authority, 32)
            || [
                &self.rust_sha256,
                &self.node_sha256,
                &self.backend_sha256,
                &self.receipt_sha256,
                &self.authority_reservation_sha256,
            ]
            .iter()
            .any(|value| !valid_hex(value, 64))
        {
            return Err(ServiceError::Invalid(
                "invalid authority or artifact digest",
            ));
        }
        if self
            .expected_installation_fingerprint
            .strip_prefix("sha256:")
            .is_none_or(|value| !valid_hex(value, 64))
        {
            return Err(ServiceError::Invalid(
                "invalid expected backend installation fingerprint",
            ));
        }
        files::directory(&self.home, &[0o700, 0o750, 0o755])?;
        files::directory(&self.home.join(".bigbud"), &[0o700, 0o755])?;
        files::directory(&self.home.join(".bigbud/backend-services"), &[0o700])?;
        files::directory(&self.config_dir(), &[0o700])?;
        let agent = self.home.join(".bigbud/agent");
        files::directory(&agent, &[0o700])?;
        let relative = self
            .rust_binary
            .strip_prefix(agent.join("bin"))
            .map_err(|_| {
                ServiceError::Invalid("Rust executable is not a managed installer path")
            })?;
        let components: Vec<_> = relative.iter().collect();
        if components.len() != 3
            || components.get(1).and_then(|part| part.to_str()) != Some(self.rust_sha256.as_str())
            || relative.file_name().and_then(|name| name.to_str()) != Some("bigbud-remote-agent")
        {
            return Err(ServiceError::Invalid(
                "Rust executable must use an immutable managed version/digest path",
            ));
        }
        let mut parent = self.rust_binary.parent();
        while let Some(path) = parent {
            files::directory(path, &[0o700])?;
            if path == agent {
                break;
            }
            parent = path.parent();
        }
        let runtimes = agent.join("runtimes");
        if self.rust_state.parent() != Some(runtimes.as_path())
            || self.backend_home.starts_with(&agent)
            || self.config_dir().starts_with(&runtimes)
        {
            return Err(ServiceError::Invalid(
                "backend authority/config must remain outside rotating Rust generations",
            ));
        }
        files::directory(&runtimes, &[0o700])?;
        files::directory(&self.rust_state, &[0o700])?;
        files::hash_file(
            &self.rust_binary,
            &self.rust_sha256,
            files::FileKind::ManagedExecutable,
        )?;
        files::hash_file(
            &self.receipt_path(),
            &self.receipt_sha256,
            files::FileKind::Private,
        )?;
        super::authority::verify(self)?;
        if role == ServiceRole::Backend {
            #[cfg(unix)]
            super::graph::verify(self)?;
            self.runtime_path()?;
            files::directory(&self.backend_home, &[0o700])?;
            files::hash_file(
                &self.node_binary,
                &self.node_sha256,
                files::FileKind::Executable,
            )?;
            files::hash_file(
                &self.backend_entry,
                &self.backend_sha256,
                files::FileKind::Data,
            )?;
            self.token()?;
        }
        Ok(())
    }

    fn token(&self) -> Result<String> {
        let bytes = files::read_private(&self.token_path(), 4096)?;
        let value = String::from_utf8(bytes)
            .map_err(|_| ServiceError::Invalid("invalid service credential"))?;
        if value.is_empty() || value.bytes().any(|byte| !byte.is_ascii_graphic()) {
            return Err(ServiceError::Invalid(
                "service credential must contain only non-whitespace ASCII",
            ));
        }
        Ok(value)
    }

    /// SDK helpers and CLI shebangs must use the same pinned Node as the backend.
    pub(super) fn runtime_path(&self) -> Result<std::ffi::OsString> {
        if self.node_binary.file_name() != Some(std::ffi::OsStr::new("node")) {
            return Err(ServiceError::Invalid(
                "private Node executable must be named node",
            ));
        }
        let directory = self.node_binary.parent().ok_or(ServiceError::Invalid(
            "private Node directory is unavailable",
        ))?;
        std::env::join_paths([
            directory,
            Path::new("/usr/local/bin"),
            Path::new("/usr/bin"),
            Path::new("/bin"),
        ])
        .map_err(|_| ServiceError::Invalid("private Node directory cannot be represented in PATH"))
    }

    /// The verified setup owns provenance. This launcher only verifies pins, then execs without
    /// a provider request, turn replay, Rust operation owner, or credential-bearing argv.
    pub(super) fn command(&self, role: ServiceRole) -> Result<Command> {
        if role == ServiceRole::Rust {
            return Err(ServiceError::Invalid(
                "Rust service requires the P4 lifetime launch guard",
            ));
        }
        self.validate_role(role)?;
        let mut command = Command::new(match role {
            ServiceRole::Backend => &self.node_binary,
            ServiceRole::Rust => &self.rust_binary,
        });
        command
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", self.runtime_path()?)
            .env("LANG", "C.UTF-8");
        match role {
            ServiceRole::Backend => {
                command
                    .arg(&self.backend_entry)
                    .env("BIGBUD_MODE", "remote")
                    .env("BIGBUD_REMOTE_SERVICE_CONFIG", self.config_path())
                    .env("BIGBUD_HOME", &self.backend_home)
                    .env("BIGBUD_AUTH_TOKEN", self.token()?)
                    .env("BIGBUD_NO_BROWSER", "true")
                    .env("BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD", "false");
            }
            ServiceRole::Rust => {
                command
                    .arg("--supervisor")
                    .env("BIGBUD_AGENT_STATE_DIR", &self.rust_state);
            }
        }
        Ok(command)
    }
}
