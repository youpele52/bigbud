use std::{
    ffi::OsString,
    fs::File,
    net::Ipv4Addr,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf, Prefix},
    time::Duration,
};

use bigbud_ssh_owner::windows_owner_pipe::{PipeReadiness, VerifiedPipe};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

use crate::{
    RunResult, invalid_input,
    owner_pipe::{PayloadPipe, decode_payload, encode_payload, protocol_error},
    profile_binding,
    v1::{ErrorCode, Folders, frame::Payload},
    windows_transport::{TransportConfig, WindowsTransport},
};

use super::{PickerTransport, Session};

#[cfg(test)]
mod tests;

const FRAME_TIMEOUT: Duration = Duration::from_secs(2);

struct VerifiedPayloads<'a>(&'a mut VerifiedPipe);

impl PayloadPipe for VerifiedPayloads<'_> {
    fn recv(&mut self) -> RunResult<Option<Payload>> {
        self.0
            .read_frame(FRAME_TIMEOUT)?
            .as_deref()
            .map(decode_payload)
            .transpose()
    }

    fn send(&mut self, payload: Payload) -> RunResult<()> {
        self.0
            .write_frame(&encode_payload(payload), FRAME_TIMEOUT)?;
        Ok(())
    }
}

impl PickerTransport for WindowsTransport {
    fn list(&self, path: Option<&str>) -> Result<Folders, ErrorCode> {
        self.list_folders(path)
    }
}

/// Fixed proof launch arguments after the mode flag:
/// PROFILE_HEX TARGET_ID LOCK_PATH PORT USER IDENTITY_PATH KNOWN_HOSTS_PATH.
/// The trusted fixture launcher must select the stable lock path for its
/// disposable SQLite profile, under a private directory it owns. It must not
/// rename or replace the lock or its parents. No host, tools, attachment,
/// arbitrary options, or workspace capabilities are supplied by the caller.
pub(crate) struct Fixture {
    profile: Vec<u8>,
    target: String,
    lock: PathBuf,
    config: TransportConfig,
}

impl Fixture {
    pub(crate) fn parse(mut args: impl Iterator<Item = OsString>) -> RunResult<Self> {
        let [profile, target, lock, port, user, identity, known_hosts] = args
            .by_ref()
            .take(7)
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| invalid_input())?;
        if args.next().is_some() {
            return Err(invalid_input().into());
        }
        let profile = profile_binding(profile.to_str().ok_or_else(invalid_input)?)?;
        let target = target.into_string().map_err(|_| invalid_input())?;
        let port: u16 = port.to_str().ok_or_else(invalid_input)?.parse()?;
        let user = user.into_string().map_err(|_| invalid_input())?;
        let lock = PathBuf::from(lock);
        if target.is_empty() || target.len() > 1024 || port == 0 || !valid_lock_path(&lock) {
            return Err(invalid_input().into());
        }
        Ok(Self {
            profile,
            target,
            lock,
            config: TransportConfig {
                host: Ipv4Addr::LOCALHOST.into(),
                port,
                user,
                identity: identity.into(),
                known_hosts: known_hosts.into(),
            },
        })
    }

    pub(crate) fn serve(self, pipe: &mut VerifiedPipe) -> RunResult<()> {
        let mut channel = VerifiedPayloads(pipe);
        let mut profile_lock = None;
        let mut session = Session::bootstrap(&mut channel, &self.profile, self.target, || {
            profile_lock = Some(lock_profile(&self.lock)?);
            WindowsTransport::new(self.config).map_err(|_| protocol_error().into())
        })?;
        loop {
            match channel.0.wait_for_input(FRAME_TIMEOUT)? {
                PipeReadiness::Idle => continue,
                PipeReadiness::Closed => return Ok(()),
                PipeReadiness::Ready => {
                    let Some(payload) = channel.recv()? else {
                        return Ok(());
                    };
                    session.dispatch(&mut channel, payload)?;
                }
            }
        }
    }
}

fn valid_lock_path(path: &Path) -> bool {
    let mut parts = path.components();
    matches!(parts.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        && matches!(parts.next(), Some(Component::RootDir))
        && path.file_name().is_some()
        && parts.all(|part| {
            matches!(part, Component::Normal(value) if value.to_str().is_some_and(|name| {
                !name.ends_with(['.', ' ']) && !name.contains([':', '\0'])
            }))
        })
}

fn lock_profile(path: &Path) -> RunResult<File> {
    // Deny deletion/replacement of the open file and never follow a final
    // reparse point. The enclosing private fixture directory is trusted.
    let file = File::options()
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid_input().into());
    }
    file.try_lock()?;
    Ok(file)
}
