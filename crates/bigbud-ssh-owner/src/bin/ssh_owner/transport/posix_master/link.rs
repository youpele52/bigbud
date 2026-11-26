//! One master link: the exact pin, image and generation this slot will spawn.
//!
//! Split from `posix_master.rs` so the slot lifecycle and the link admission
//! stay independent. The fixture and production lanes share this machinery;
//! only the image validator differs.

use super::{
    ErrorCode, HostKey, Master, PinnedSsh, PosixMasterSlot, PrivatePaths, Stamp, Transport,
    TransportConfig, UNAVAILABLE, launch, trust_store,
};
use crate::Token;
use std::process::Command;
use std::sync::Arc;

impl PosixMasterSlot {
    #[cfg(any(test, target_os = "linux"))]
    pub(super) fn prepare(
        &mut self,
        transport: &Transport,
        generation: Token,
        allocate: impl FnOnce() -> Result<PrivatePaths, ErrorCode>,
        auth_options: &[&str],
    ) -> Result<Command, ErrorCode> {
        self.prepare_with(
            transport,
            generation,
            allocate,
            auth_options,
            TrustRead::Default,
            false,
        )
    }

    pub(super) fn prepare_with(
        &mut self,
        transport: &Transport,
        generation: Token,
        allocate: impl FnOnce() -> Result<PrivatePaths, ErrorCode>,
        auth_options: &[&str],
        trust: TrustRead,
        production: bool,
    ) -> Result<Command, ErrorCode> {
        self.prepare_link(
            transport,
            generation,
            allocate,
            auth_options,
            trust,
            LinkMode {
                forwarded: false,
                production,
            },
        )
    }

    pub(super) fn prepare_link(
        &mut self,
        transport: &Transport,
        generation: Token,
        allocate: impl FnOnce() -> Result<PrivatePaths, ErrorCode>,
        auth_options: &[&str],
        trust: TrustRead,
        mode: LinkMode,
    ) -> Result<Command, ErrorCode> {
        let LinkMode {
            forwarded,
            production,
        } = mode;
        if self.master.is_some() || forwarded && !auth_options.is_empty() {
            return Err(UNAVAILABLE);
        }
        // A production credential master serves the production list lane;
        // only the disposable fixture keeps its password-only listing fence.
        let password = !auth_options.is_empty() && !production;
        let executable = if production {
            launch::validate_production(transport)?
        } else {
            launch::validate_fixture_for_auth(transport, password)?
        };
        let pinned = if forwarded && transport.connector().is_some() {
            transport.connector_pinned_ssh("-T")?
        } else {
            trust.pinned(transport)?
        };
        // Bind the actual snapshot used by this child, not an independent read
        // of the live store that could race snapshot construction.
        let read_snapshot = match trust {
            TrustRead::Default => trust_store::read,
            #[cfg(target_os = "macos")]
            TrustRead::PlainFixture => trust_store::read_plain,
        };
        let key = read_snapshot(pinned._snapshot.path(), &transport.host_label)?
            .ok_or(ErrorCode::TrustRequired)?
            .key;
        let binding = Binding {
            generation,
            scope: Arc::clone(&transport.config),
            key,
            executable,
            password,
            production,
        };
        binding.revalidate_with(transport, trust)?;
        let path = allocate()?;
        let command = launch::master_command_for_link(
            &pinned,
            &path.socket,
            transport.host(),
            auth_options,
            forwarded,
        );
        // The slot keeps the exact pin through checked reap, including when a
        // failed launch cannot yet be reaped and must remain unavailable.
        self.master = Some(Master {
            binding,
            paths: path,
            child: None,
            death_watch: None,
            connector: None,
            recovery: None,
            socket: None,
            closing: false,
            _pin: pinned._snapshot,
            retirement: self.retirement.clone(),
            master_record: None,
            connector_record: None,
            published: None,
        });
        Ok(command)
    }
}

pub(super) struct Binding {
    pub(super) generation: Token,
    pub(super) scope: Arc<TransportConfig>,
    pub(super) key: HostKey,
    pub(super) executable: Stamp,
    pub(super) password: bool,
    pub(super) production: bool,
}

#[derive(Clone, Copy)]
pub(super) enum TrustRead {
    Default,
    #[cfg(target_os = "macos")]
    PlainFixture,
}

/// Which master lane is being opened. The fixture and production lanes share
/// the slot machinery but validate different images.
#[derive(Clone, Copy)]
pub(super) struct LinkMode {
    pub(super) forwarded: bool,
    pub(super) production: bool,
}

impl TrustRead {
    pub(super) fn pin(self, transport: &Transport) -> Result<Option<trust_store::Pin>, ErrorCode> {
        match self {
            Self::Default => transport.pin(),
            #[cfg(target_os = "macos")]
            Self::PlainFixture => {
                trust_store::read_plain(&transport.config.known_hosts, &transport.host_label)
            }
        }
    }

    pub(super) fn pinned(self, transport: &Transport) -> Result<PinnedSsh, ErrorCode> {
        match self {
            Self::Default => transport.pinned_master_ssh("-T"),
            #[cfg(target_os = "macos")]
            Self::PlainFixture => {
                let pin = self.pin(transport)?.ok_or(ErrorCode::TrustRequired)?;
                transport.ssh_for_pin(
                    "-T",
                    None,
                    false,
                    &pin,
                    super::super::HostVerification::Ed25519Key,
                )
            }
        }
    }
}

impl Binding {
    pub(super) fn revalidate(&self, transport: &Transport) -> Result<(), ErrorCode> {
        self.revalidate_with(transport, TrustRead::Default)
    }

    pub(super) fn revalidate_with(
        &self,
        transport: &Transport,
        trust: TrustRead,
    ) -> Result<(), ErrorCode> {
        let executable = if self.production {
            launch::validate_production(transport)?
        } else {
            launch::validate_fixture_for_auth(transport, self.password)?
        };
        if executable != self.executable {
            return Err(ErrorCode::ConfigUnsupported);
        }
        if trust.pin(transport)?.ok_or(ErrorCode::TrustRequired)?.key != self.key {
            return Err(ErrorCode::HostKeyChanged);
        }
        Ok(())
    }
}
