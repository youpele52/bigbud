//! Trusted private bootstrap inputs for an isolated alias. These facts are not
//! part of the picker RPC. Never infer a local account from a remote login or
//! infer an explicit override from the bootstrap's resolved endpoint binding.
use crate::{
    config::{LocalAccountFact, RouteFacts, RouteOverrides},
    invalid_input,
    transport::{ConnectorApproval, TransportConfig},
};
use std::{
    ffi::OsString, fs, io, net::IpAddr, num::NonZeroU16, os::unix::fs::MetadataExt, path::Path,
};

#[derive(Default)]
pub(super) struct ProofRouteFacts {
    account: Option<(u32, String)>,
    host: Option<IpAddr>,
    user: Option<String>,
    port: Option<NonZeroU16>,
    connector_image: Option<[u8; 32]>,
    connector_path: Vec<std::path::PathBuf>,
}

impl ProofRouteFacts {
    pub(super) fn parse(
        &mut self,
        flag: &str,
        args: &mut impl Iterator<Item = OsString>,
    ) -> io::Result<()> {
        let mut next = || {
            args.next()
                .and_then(|arg| arg.into_string().ok())
                .ok_or_else(invalid_input)
        };
        match flag {
            "--fixture-local-account" if self.account.is_none() => {
                let uid = next()?.parse().map_err(|_| invalid_input())?;
                self.account = Some((uid, next()?));
            }
            "--fixture-override-host" if self.host.is_none() => {
                self.host = Some(next()?.parse().map_err(|_| invalid_input())?)
            }
            "--fixture-override-user" if self.user.is_none() => self.user = Some(next()?),
            "--fixture-override-port" if self.port.is_none() => {
                self.port = Some(next()?.parse().map_err(|_| invalid_input())?)
            }
            "--fixture-connector-image" if self.connector_image.is_none() => {
                let hex = next()?;
                let mut image = [0; 32];
                if hex.len() != 64 {
                    return Err(invalid_input());
                }
                for (byte, pair) in image.iter_mut().zip(hex.as_bytes().chunks(2)) {
                    let pair = std::str::from_utf8(pair).map_err(|_| invalid_input())?;
                    *byte = u8::from_str_radix(pair, 16).map_err(|_| invalid_input())?;
                }
                self.connector_image = Some(image);
            }
            "--fixture-connector-path" if self.connector_path.len() < 4 => {
                self.connector_path.push(next()?.into());
            }
            _ => return Err(invalid_input()),
        }
        Ok(())
    }

    pub(super) fn bind(self, config: &TransportConfig) -> io::Result<RouteFacts> {
        if self.account.is_none()
            && self.host.is_none()
            && self.user.is_none()
            && self.port.is_none()
            && self.connector_image.is_none()
            && self.connector_path.is_empty()
        {
            return Ok(RouteFacts::default());
        }
        let root = config
            .identity
            .parent()
            .filter(|path| disposable_root(path))
            .ok_or_else(invalid_input)?;
        let (alias, _) = config.alias_config.as_ref().ok_or_else(invalid_input)?;
        let metadata = fs::symlink_metadata(root)?;
        // SAFETY: geteuid takes no arguments and observes the current process only.
        let uid = unsafe { libc::geteuid() };
        // Linux admits only the connector approval, not account or route overrides.
        let linux_connector_only = cfg!(target_os = "linux")
            && self.account.is_none()
            && self.host.is_none()
            && self.user.is_none()
            && self.port.is_none();
        if !(cfg!(target_os = "macos") || linux_connector_only)
            || uid == 0
            || !metadata.is_dir()
            || metadata.uid() != uid
            || metadata.mode() & 0o7777 != 0o700
            || !config.host.is_loopback()
            || alias.parent() != Some(root)
            || config
                .system_config
                .as_ref()
                .is_some_and(|path| path.parent() != Some(root))
            || self
                .account
                .as_ref()
                .is_some_and(|(account_uid, _)| *account_uid != uid)
        {
            return Err(invalid_input());
        }
        let local_account = self
            .account
            .map(|(uid, name)| LocalAccountFact::new(uid, &name))
            .transpose()
            .map_err(|_| invalid_input())?;
        let overrides = RouteOverrides::new(self.host, self.user.as_deref(), self.port)
            .map_err(|_| invalid_input())?;
        let facts = RouteFacts::new(local_account, overrides);
        match (self.connector_image, self.connector_path.is_empty()) {
            (None, true) => Ok(facts),
            (Some(image), false) => Ok(facts.with_connector(
                ConnectorApproval::new(image, self.connector_path).map_err(|_| invalid_input())?,
            )),
            _ => Err(invalid_input()),
        }
    }
}

fn disposable_root(root: &Path) -> bool {
    let (parent, prefix) = if cfg!(target_os = "linux") {
        ("/tmp", "bigbud-picker-linux-")
    } else {
        ("/private/tmp", "bigbud-picker-sshd-")
    };
    root.parent() == Some(Path::new(parent))
        && root
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(prefix))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 64
                    && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
}
