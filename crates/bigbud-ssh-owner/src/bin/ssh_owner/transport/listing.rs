use super::{
    DEADLINE, ErrorCode, Folders, HostVerification, PinnedSsh, Transport, folders, process,
};
use std::ffi::OsString;
use std::time::Instant;

const LIST_LIMIT: usize = 1024 * 1024;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(in super::super) enum ListFailure {
    Cancelled,
    CleanupUnconfirmed,
    Error(ErrorCode),
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl From<ErrorCode> for ListFailure {
    fn from(error: ErrorCode) -> Self {
        Self::Error(error)
    }
}

impl Transport {
    pub(in super::super) fn list_folders(&self, path: Option<&str>) -> Result<Folders, ErrorCode> {
        self.list_folders_with_locale(path, std::env::vars_os)
    }

    pub(in super::super) fn list_folders_with_locale<I>(
        &self,
        path: Option<&str>,
        locale_source: impl FnOnce() -> I,
    ) -> Result<Folders, ErrorCode>
    where
        I: Iterator<Item = (OsString, OsString)>,
    {
        let (PinnedSsh { command, _snapshot }, deadline) =
            self.prepare_listing(path, locale_source, |deadline| {
                let timers = self.policy.as_ref().map(|policy| &policy.timers);
                let verification = self.host_verification();
                match verification {
                    HostVerification::Ed25519Key => {
                        self.pinned_ssh_with_timers("-T", timers, false)
                    }
                    HostVerification::Ed25519Certificate => {
                        let ca = self.certificate_authority(deadline)?;
                        self.ssh_for_pin("-T", timers, false, &ca, verification)
                    }
                }
            })?;
        let output = process::run_picker(command, deadline, LIST_LIMIT).map_err(process_failure)?;
        parse_listing(output)
    }

    #[cfg(target_os = "macos")]
    pub(in super::super) fn list_folders_cancellable(
        &self,
        path: Option<&str>,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<Folders, ListFailure> {
        if is_cancelled() {
            return Err(ListFailure::Cancelled);
        }
        // Configured trust may run separate helpers. The cancellable fixture
        // lane owns only the direct, non-mux SSH process and its group.
        if self.policy.is_some() {
            return Err(ErrorCode::ConfigUnsupported.into());
        }
        let (PinnedSsh { command, _snapshot }, deadline) =
            self.prepare_listing(path, std::iter::empty, |_| {
                let pin =
                    super::trust_store::read_plain(&self.config.known_hosts, &self.host_label)?
                        .ok_or(ErrorCode::TrustRequired)?;
                self.ssh_for_pin("-T", None, false, &pin, HostVerification::Ed25519Key)
            })?;
        let output = process::run_picker_cancellable(command, deadline, LIST_LIMIT, is_cancelled)
            .map_err(|failure| match failure {
            process::PickerFailure::Cancelled => ListFailure::Cancelled,
            process::PickerFailure::CleanupUnconfirmed => ListFailure::CleanupUnconfirmed,
            process::PickerFailure::Process(error) => process_failure(error).into(),
        })?;
        Ok(parse_listing(output)?)
    }

    fn prepare_listing<I>(
        &self,
        path: Option<&str>,
        locale_source: impl FnOnce() -> I,
        prepare_ssh: impl FnOnce(Instant) -> Result<PinnedSsh, ErrorCode>,
    ) -> Result<(PinnedSsh, Instant), ErrorCode>
    where
        I: Iterator<Item = (OsString, OsString)>,
    {
        self.revalidate_policy()?;
        let deadline = Instant::now() + DEADLINE;
        let remote = folders::command(path)?;
        let PinnedSsh {
            command: mut ssh,
            _snapshot,
        } = prepare_ssh(deadline)?;
        if let Some(policy) = &self.policy {
            policy.send_env.apply_to(&mut ssh, locale_source)?;
        } else {
            ssh = process::clean(ssh);
        }
        ssh.args(["--", &self.host, &remote]);
        Ok((
            PinnedSsh {
                command: ssh,
                _snapshot,
            },
            deadline,
        ))
    }
}

fn process_failure(error: process::Failure) -> ErrorCode {
    match error {
        process::Failure::TimedOut => ErrorCode::ListTimedOut,
        process::Failure::Spawn => ErrorCode::OwnerUnavailable,
        process::Failure::Io => ErrorCode::TransportLost,
    }
}

fn parse_listing(output: process::Output) -> Result<Folders, ErrorCode> {
    match output.status.code() {
        Some(0) => folders::parse(&output.stdout, output.truncated),
        Some(3) => Err(ErrorCode::ListPathUnavailable),
        Some(255) => Err(process::ssh_failure(&output.stderr)),
        None => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::ListFailed),
    }
}
