use super::diagnostic::{ConfigFailure, Located};
use super::paths::{self, Route};
use super::source::Scope;
use super::{ErrorCode, UNSUPPORTED};
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum AgentSetting {
    Disabled,
    Socket(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdentityAgent {
    Absent,
    Disabled,
    Socket(PathBuf),
}

impl AgentSetting {
    pub(super) fn parse(value: &str) -> Result<Self, ErrorCode> {
        if value == "none" {
            return Ok(Self::Disabled);
        }
        // Never look up `$SSH_AUTH_SOCK` or other environment inputs. This
        // slice admits only concrete fixture paths, not token substitution.
        if value.contains('%') {
            return Err(UNSUPPORTED);
        }
        paths::validate_auth_operand(value)?;
        Ok(Self::Socket(value.to_owned()))
    }

    pub(super) fn resolve(
        setting: Option<&Located<Self>>,
        scope: &Scope,
        route: &Route<'_>,
    ) -> Result<IdentityAgent, ConfigFailure> {
        let Some(setting) = setting else {
            return Ok(IdentityAgent::Absent);
        };
        match &setting.value {
            Self::Disabled => Ok(IdentityAgent::Disabled),
            Self::Socket(value) => paths::auth_file(scope, value, route)
                .map(IdentityAgent::Socket)
                .map_err(|code| setting.diagnostic.reject(code)),
        }
    }
}
