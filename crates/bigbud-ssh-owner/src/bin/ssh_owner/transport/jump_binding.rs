//! One private pre-pinned Linux picker route. The dispatcher refuses any
//! other network verb while this synthetic route is installed.

mod first_use;

use super::{ErrorCode, Folders, Transport, TransportConfig, posix_master::PosixMasterSlot};
use crate::{
    Token,
    config::RouteFacts,
    v1::{Error, JumpFailure, JumpStage},
};
use std::{
    path::Path,
    time::{Duration, Instant},
};

use super::posix_master::jump::{Failure, Route, Stage};

pub(crate) struct JumpPicker {
    hops: Vec<Transport>,
    retirement: Option<crate::owner::retirement::Retirement>,
    root: std::path::PathBuf,
    active: Option<Route>,
    trust_fault: Option<Error>,
    first_use: bool,
    trust: crate::owner_trust::TrustApproval<first_use::RouteKey>,
}

impl JumpPicker {
    pub(crate) fn bind(
        config: TransportConfig,
        lock: &Path,
        facts: &RouteFacts,
        retirement: Option<crate::owner::retirement::Retirement>,
    ) -> Result<(Transport, Self), ErrorCode> {
        let denied = ErrorCode::ConfigUnsupported;
        let root = lock.parent().ok_or(denied)?.to_owned();
        let (path, alias) = config.alias_config.as_ref().ok_or(denied)?;
        if root.parent() != Some(Path::new("/tmp"))
            || lock.file_name().and_then(|name| name.to_str()) != Some("owner.lock")
            || path.parent() != Some(&root)
            || !root
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix("bigbud-picker-linux-"))
                .is_some_and(|suffix| {
                    !suffix.is_empty()
                        && suffix.len() <= 64
                        && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
                })
            || config.workspace_root.is_some()
            || config.dev_interactive_terminal
        {
            return Err(denied);
        }
        PosixMasterSlot::require_no_residual_lease(&root)?;
        let mut route = crate::config::jump::resolve_chain(
            path,
            config.system_config.as_deref(),
            alias,
            facts.clone(),
        )
        .map_err(|failure| failure.code)?;
        let destination = route.pop().ok_or(denied)?;
        let mut hops = Vec::with_capacity(route.len());
        for hop in route {
            let known_hosts = hop.known_hosts.clone().ok_or(denied)?;
            let hop_config = TransportConfig {
                ssh: config.ssh.clone(),
                keyscan: config.keyscan.clone(),
                host: hop.host,
                port: hop.port,
                user: hop.user.clone(),
                identity: hop.identity.clone(),
                known_hosts,
                alias_config: config.alias_config.clone(),
                system_config: config.system_config.clone(),
                workspace_root: None,
                dev_interactive_terminal: false,
            };
            let transport = Transport::new_with_policy(hop_config, false, |_| Ok(Some(hop)))?;
            transport.images.require_mounted_linux_fixture()?;
            hops.push(transport);
        }
        let destination = Transport::new_with_policy(config, false, |_| Ok(Some(destination)))?;
        destination.images.require_mounted_linux_fixture()?;
        Ok((
            destination,
            Self {
                hops,
                retirement,
                root,
                active: None,
                trust_fault: None,
                first_use: std::env::var_os("BIGBUD_SSH_OWNER_JUMP_FIRST_USE").as_deref()
                    == Some(std::ffi::OsStr::new("1")),
                trust: Default::default(),
            },
        ))
    }

    pub(crate) fn list(
        &mut self,
        destination: &Transport,
        generation: Token,
        path: Option<&str>,
    ) -> Result<Folders, Error> {
        if let Some(error) = &self.trust_fault {
            return Err(*error);
        }
        let legs = self
            .hops
            .iter()
            .chain(std::iter::once(destination))
            .collect::<Vec<_>>();
        let route = self.active.get_or_insert_with(|| {
            Route::new(generation, Some(self.root.clone()), self.retirement.clone())
        });
        if !route.matches(generation) {
            return Err(Error {
                code: ErrorCode::StaleGeneration.into(),
                jump_failure: None,
            });
        }
        route
            .browse(&legs, path, Instant::now() + Duration::from_secs(10))
            .map_err(|failure| {
                let error = wire_failure(&failure);
                if matches!(
                    failure.code,
                    ErrorCode::HostKeyChanged
                        | ErrorCode::TrustStoreReadOnly
                        | ErrorCode::ConfigUnsupported
                ) || !self.first_use && failure.code == ErrorCode::TrustRequired
                {
                    self.trust_fault = Some(error);
                }
                error
            })
    }

    pub(crate) fn retire(&mut self) -> Result<(), ErrorCode> {
        if let Some(route) = &mut self.active {
            route.retire().map_err(|failure| failure.code)?;
        }
        self.active = None;
        Ok(())
    }

    pub(crate) fn revoke_challenge(&mut self) {
        self.trust.revoke();
    }

    pub(crate) fn allows_first_use(&self) -> bool {
        self.first_use
    }

    pub(crate) fn transition_committed(&mut self) {
        self.trust_fault = None;
    }
}

fn wire_failure(failure: &Failure) -> Error {
    let stage = match failure.stage {
        Stage::Admission => JumpStage::Admission,
        Stage::Forward => JumpStage::Forward,
        Stage::Handshake => JumpStage::Handshake,
        Stage::Listing => JumpStage::Listing,
        Stage::Retirement => JumpStage::Retirement,
    };
    Error {
        code: failure.code.into(),
        jump_failure: u32::try_from(failure.leg).ok().map(|leg| JumpFailure {
            leg,
            stage: stage.into(),
        }),
    }
}
