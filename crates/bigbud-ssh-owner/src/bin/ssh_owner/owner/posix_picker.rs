//! Opt-in Mac loopback picker integration only. No direct-path fallback.
use super::reconnect::RetryWindow;
use crate::{
    Token,
    owner::retirement::Retirement,
    startup_bindings::PosixPickerFixture,
    transport::{Transport, TransportConfig, posix_master::PosixMasterSlot},
    v1::{ErrorCode, Folders},
};
use std::{
    net::Ipv4Addr,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const PICKER_DEADLINE: Duration = Duration::from_secs(10);

pub(in super::super) fn is_disposable_picker(
    config: &TransportConfig,
    mode: PosixPickerFixture,
    attachment: Option<&Path>,
) -> bool {
    let Some(root) = config.identity.parent() else {
        return false;
    };
    let scoped_root = match mode {
        PosixPickerFixture::Key => cfg!(target_os = "macos") && is_disposable_root(root),
        #[cfg(target_os = "macos")]
        PosixPickerFixture::CancellableRead | PosixPickerFixture::CancellableMuxRead => {
            is_disposable_root(root)
        }
        // Key-authenticated owned mux lane in the private Linux fixture namespace.
        #[cfg(target_os = "linux")]
        PosixPickerFixture::CancellableMuxRead => {
            is_linux_disposable_root(root) && config.user == "picker" && config.port == 22222
        }
        // The connector lane requires the fixture's private alias policy.
        #[cfg(target_os = "macos")]
        PosixPickerFixture::Connector => is_disposable_root(root),
        #[cfg(target_os = "linux")]
        PosixPickerFixture::Connector => {
            is_linux_disposable_root(root) && config.user == "picker" && config.port == 22222
        }
        #[cfg(target_os = "linux")]
        PosixPickerFixture::SyntheticPassword => {
            is_linux_disposable_root(root) && config.user == "picker" && config.port == 22222
        }
    };
    scoped_root
        && attachment.is_none_or(|socket| {
            mode == PosixPickerFixture::Key && socket == root.join("owner.sock")
        })
        && config.identity == root.join("identity")
        && config.known_hosts == root.join("known_hosts")
        && config.host == Ipv4Addr::LOCALHOST
        && config.port >= 1024
        && alias_matches_mode(config, mode, root)
        && config.system_config.is_none()
        && config.workspace_root.is_none()
        && !config.dev_interactive_terminal
}

fn alias_matches_mode(config: &TransportConfig, mode: PosixPickerFixture, root: &Path) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if mode == PosixPickerFixture::Connector {
        return config
            .alias_config
            .as_ref()
            .is_some_and(|(path, _)| path.parent() == Some(root));
    }
    let _ = (mode, root);
    config.alias_config.is_none()
}

pub(super) fn is_disposable_root(root: &Path) -> bool {
    root.parent() == Some(Path::new("/private/tmp"))
        && root
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("bigbud-picker-sshd-"))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 64
                    && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
}

/// After obtaining the profile lock, refuse residual master leases even if a
/// replacement launcher omits the fixture's mux opt-in. Never adopt or reap an
/// unverified process or socket from an earlier owner.
#[cfg(target_os = "macos")]
pub(super) fn fence_residual_leases(
    lock: &Path,
    config: &TransportConfig,
    selected: bool,
) -> Result<(), ErrorCode> {
    let lock_root = lock.parent().filter(|root| is_disposable_root(root));
    let identity_root = config
        .identity
        .parent()
        .filter(|root| is_disposable_root(root));
    if selected
        && (lock_root.is_none()
            || lock_root != identity_root
            || lock.file_name().and_then(|name| name.to_str()) != Some("owner.lock"))
    {
        return Err(ErrorCode::OperationDenied);
    }
    if let Some(root) = lock_root {
        PosixMasterSlot::require_no_residual_lease(root)?;
    }
    if let Some(root) = identity_root.filter(|root| Some(*root) != lock_root) {
        PosixMasterSlot::require_no_residual_lease(root)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn is_linux_disposable_root(root: &Path) -> bool {
    root.parent() == Some(Path::new("/tmp"))
        && root
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|value| value.strip_prefix("bigbud-picker-linux-"))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 64
                    && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
            })
}

#[cfg(target_os = "linux")]
pub(super) fn fence_linux_password_leases(
    lock: &Path,
    config: &TransportConfig,
    mode: Option<PosixPickerFixture>,
) -> Result<(), ErrorCode> {
    if let Some(mode) = mode {
        let root = config.identity.parent().ok_or(ErrorCode::OperationDenied)?;
        if !matches!(
            mode,
            PosixPickerFixture::SyntheticPassword
                | PosixPickerFixture::CancellableMuxRead
                | PosixPickerFixture::Connector
        ) || !is_disposable_picker(config, mode, None)
            || lock != root.join("owner.lock")
        {
            return Err(ErrorCode::OperationDenied);
        }
        return PosixMasterSlot::require_no_residual_lease(root);
    }
    let lock_root = lock.parent().filter(|root| is_linux_disposable_root(root));
    let identity_root = config
        .identity
        .parent()
        .filter(|root| is_linux_disposable_root(root));
    if let Some(root) = lock_root {
        PosixMasterSlot::require_no_residual_fixture_entry(root)?;
    }
    if let Some(root) = identity_root.filter(|root| Some(*root) != lock_root) {
        PosixMasterSlot::require_no_residual_fixture_entry(root)?;
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum MasterMode {
    /// Disposable loopback picker fixtures, unchanged.
    Fixture(PosixPickerFixture),
    /// A real target resolved by the owner in production mode.
    Production,
}

impl Default for MasterMode {
    fn default() -> Self {
        Self::Fixture(PosixPickerFixture::default())
    }
}

#[derive(Default)]
pub(super) struct MasterPicker {
    slot: PosixMasterSlot,
    mode: MasterMode,
    /// Owner-private state root for the production control path; unused by the
    /// disposable fixture, which allocates inside its identity directory.
    production_root: Option<PathBuf>,
    generation: Option<Token>,
    verified: bool,
    trust_fault: Option<ErrorCode>,
    retry: RetryWindow,
}

impl MasterPicker {
    pub(super) fn new(mode: PosixPickerFixture, retirement: Option<Retirement>) -> Self {
        Self {
            slot: PosixMasterSlot::new(retirement),
            mode: MasterMode::Fixture(mode),
            ..Self::default()
        }
    }

    pub(super) fn list(
        &mut self,
        transport: &Transport,
        generation: Token,
        path: Option<&str>,
    ) -> Result<Folders, ErrorCode> {
        self.admit(generation)?;
        let result = match self.mode {
            MasterMode::Production => self.list_production(transport, generation, path),
            MasterMode::Fixture(mode) => {
                let deadline = Instant::now() + PICKER_DEADLINE;
                match mode {
                    #[cfg(target_os = "macos")]
                    PosixPickerFixture::CancellableRead
                    | PosixPickerFixture::CancellableMuxRead => Err(ErrorCode::OperationDenied),
                    #[cfg(target_os = "linux")]
                    PosixPickerFixture::CancellableMuxRead => Err(ErrorCode::OperationDenied),
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    PosixPickerFixture::Connector => self
                        .slot
                        .open_and_list_folders(transport, generation, path, deadline),
                    PosixPickerFixture::Key => self
                        .slot
                        .open_and_list_folders(transport, generation, path, deadline),
                    #[cfg(target_os = "linux")]
                    PosixPickerFixture::SyntheticPassword => self
                        .slot
                        .list_unlocked_folders(transport, generation, path, deadline),
                }
            }
        };
        self.record_observation(generation, result.as_ref().err().copied());
        result
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn list_cancellable(
        &mut self,
        transport: &Transport,
        generation: Token,
        path: Option<&str>,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<Folders, crate::transport::ListFailure> {
        use crate::transport::ListFailure;
        // No production request carries a cancellation inbox; the fixture mux
        // lane is the only cancellable lane.
        if self.mode != MasterMode::Fixture(PosixPickerFixture::CancellableMuxRead) {
            return Err(ErrorCode::OperationDenied.into());
        }
        self.admit(generation)?;
        let result = self.slot.open_and_list_folders_cancellable(
            transport,
            generation,
            path,
            Instant::now() + PICKER_DEADLINE,
            is_cancelled,
        );
        match &result {
            Ok(_) => self.record_observation(generation, None),
            Err(ListFailure::Error(code)) => self.record_observation(generation, Some(*code)),
            // Cancellation is neither a retry trigger nor a trust-policy change.
            Err(ListFailure::Cancelled | ListFailure::CleanupUnconfirmed) => {}
        }
        result
    }

    fn admit(&mut self, generation: Token) -> Result<(), ErrorCode> {
        // Retain the original fence even if launch returns an uncertain reap.
        if self
            .generation
            .is_some_and(|existing| existing != generation)
        {
            return Err(ErrorCode::StaleGeneration);
        }
        if let Some(error) = self.trust_fault {
            return Err(error);
        }
        self.retry.admit(Instant::now())?;
        self.generation = Some(generation);
        Ok(())
    }

    fn record_observation(&mut self, generation: Token, error: Option<ErrorCode>) {
        match error {
            None | Some(ErrorCode::ListPathUnavailable | ErrorCode::ListFailed) => {
                self.verified = true;
                self.retry = RetryWindow::default();
            }
            Some(ErrorCode::TransportLost | ErrorCode::ListTimedOut) => {
                let jitter = generation
                    .first_chunk::<8>()
                    .copied()
                    .map_or(0, u64::from_le_bytes);
                self.retry.record_failure(Instant::now(), jitter);
            }
            Some(
                error @ (ErrorCode::HostKeyChanged
                | ErrorCode::TrustRequired
                | ErrorCode::TrustStoreReadOnly
                | ErrorCode::ConfigUnsupported),
            ) if self.verified => {
                // A known lease lost its trust or policy. Restoring a file behind
                // its back must not authorize a replacement in this generation.
                self.trust_fault = Some(error);
            }
            Some(_) => {}
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn unlock_synthetic(
        &mut self,
        transport: &Transport,
        generation: Token,
    ) -> Result<(), ErrorCode> {
        if self.mode != MasterMode::Fixture(PosixPickerFixture::SyntheticPassword) {
            return Err(ErrorCode::OperationDenied);
        }
        if self
            .generation
            .is_some_and(|previous| previous != generation)
        {
            return Err(ErrorCode::StaleGeneration);
        }
        if let Some(error) = self.trust_fault {
            return Err(error);
        }
        self.generation = Some(generation);
        // Disposable credential fixed by the fixture. The protocol has no password field.
        let mut password = *b"S2-synthetic-owner-password";
        self.slot.unlock_password(
            transport,
            generation,
            &mut password,
            Instant::now() + PICKER_DEADLINE,
        )?;
        self.retry = RetryWindow::default();
        self.verified = true;
        Ok(())
    }

    pub(super) fn retire(&mut self) -> Result<(), ErrorCode> {
        if let Some(generation) = self.generation {
            self.slot.invalidate(generation)?;
        }
        Ok(())
    }

    /// True while this picker holds a live control master.
    pub(super) fn has_live_master(&self) -> bool {
        self.slot.has_live_master()
    }

    pub(super) fn rebind_generation(&mut self) -> Result<(), ErrorCode> {
        // A storage handoff rotates the request fence. Never adopt the old
        // transport into the new generation, or lift a pause without Connect.
        self.retire()?;
        self.generation = None;
        Ok(())
    }

    pub(super) fn transition_committed(&mut self) {
        // The owner calls this only after the previous lease has been reaped
        // and the durable Connect/Disconnect transition has been acknowledged.
        self.generation = None;
        self.verified = false;
        self.trust_fault = None;
        self.retry = RetryWindow::default();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "posix_picker.production.rs"]
mod production;

#[cfg(test)]
#[path = "posix_picker.production.live.tests.rs"]
mod production_live_tests;
#[cfg(test)]
#[path = "posix_picker.production.tests.rs"]
mod production_tests;
#[cfg(test)]
#[path = "posix_picker_tests.rs"]
mod tests;
