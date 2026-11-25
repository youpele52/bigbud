//! Immutable, trusted fixture startup facts. The caller, not this resolver,
//! authenticates the initiating account and the provenance of each override.

use super::syntax::safe_token;
use super::{ErrorCode, UNSUPPORTED};
use crate::transport::ConnectorApproval;
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use std::num::NonZeroU16;

#[derive(Clone)]
pub(crate) struct LocalAccountFact {
    uid: u32,
    name: String,
}

impl LocalAccountFact {
    pub(crate) fn new(uid: u32, name: &str) -> Result<Self, ErrorCode> {
        if !safe_token(name, 64) {
            return Err(UNSUPPORTED);
        }
        Ok(Self {
            uid,
            name: name.to_owned(),
        })
    }
}

#[derive(Clone, Default)]
pub(crate) struct RouteOverrides {
    pub(super) host: Option<String>,
    pub(super) user: Option<String>,
    pub(super) port: Option<NonZeroU16>,
}

impl RouteOverrides {
    pub(crate) fn new(
        host: Option<IpAddr>,
        user: Option<&str>,
        port: Option<NonZeroU16>,
    ) -> Result<Self, ErrorCode> {
        if host.is_some_and(|host| !host.is_loopback())
            || user.is_some_and(|name| !safe_token(name, 64))
        {
            return Err(UNSUPPORTED);
        }
        Ok(Self {
            host: host.map(|host| host.to_string()),
            user: user.map(str::to_owned),
            port,
        })
    }
}

#[derive(Clone, Default)]
pub(crate) struct RouteFacts {
    local_account: Option<LocalAccountFact>,
    pub(super) overrides: RouteOverrides,
    #[cfg(any(test, target_os = "linux"))]
    pub(super) allow_jump: bool,
    connector: Option<ConnectorApproval>,
}

impl RouteFacts {
    pub(crate) fn new(local_account: Option<LocalAccountFact>, overrides: RouteOverrides) -> Self {
        Self {
            local_account,
            overrides,
            #[cfg(any(test, target_os = "linux"))]
            allow_jump: false,
            connector: None,
        }
    }

    /// Trusted approval for the restricted connector; never read from config.
    pub(crate) fn with_connector(mut self, approval: ConnectorApproval) -> Self {
        self.connector = Some(approval);
        self
    }

    pub(crate) fn connector(&self) -> Option<&ConnectorApproval> {
        self.connector.as_ref()
    }

    #[cfg(any(test, target_os = "linux"))]
    pub(super) fn for_hop(&self, overrides: RouteOverrides) -> Self {
        Self::new(self.local_account.clone(), overrides)
    }

    pub(super) fn local_user(&self) -> Option<&str> {
        self.local_account.as_ref().map(|fact| fact.name.as_str())
    }

    pub(super) fn fingerprint(&self) -> [u8; 32] {
        let mut digest = Sha256::new();
        digest.update(b"bigbud.ssh-owner.fixture-route-facts.v1\0");
        if let Some(account) = &self.local_account {
            digest.update([1]);
            digest.update(account.uid.to_be_bytes());
            digest.update(account.name.as_bytes());
            digest.update([0]);
        } else {
            digest.update([0]);
        }
        hash_optional_text(&mut digest, self.overrides.host.as_deref());
        hash_optional_text(&mut digest, self.overrides.user.as_deref());
        if let Some(port) = self.overrides.port {
            digest.update([1]);
            digest.update(port.get().to_be_bytes());
        } else {
            digest.update([0]);
        }
        #[cfg(any(test, target_os = "linux"))]
        if self.allow_jump {
            digest.update(b"jump");
        }
        if let Some(connector) = &self.connector {
            connector.fingerprint_into(&mut digest);
        }
        digest.finalize().into()
    }
}

fn hash_optional_text(digest: &mut Sha256, value: Option<&str>) {
    // All admitted identity/host characters exclude NUL.
    if let Some(value) = value {
        digest.update([1]);
        digest.update(value.as_bytes());
    }
    digest.update([0]);
}
