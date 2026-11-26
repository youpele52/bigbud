//! A password is supplied for one foreground, pinned handshake only. The
//! owner retains the verified mux, not the password or an askpass service.

mod askpass;
mod process;
mod production;
#[cfg(test)]
mod tests;

#[cfg(target_os = "linux")]
use super::paths;
#[cfg(any(test, target_os = "linux"))]
use super::{
    CHECK_LIMIT, ErrorCode, Folders, LOST, Master, PosixMasterSlot, PrivatePaths, READY_LIMIT,
    Transport, UNAVAILABLE, pause, session,
};
#[cfg(any(test, target_os = "linux"))]
use crate::Token;
#[cfg(any(test, target_os = "linux"))]
use std::{net::Ipv4Addr, path::Path, time::Instant};

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(in super::super::super) use askpass::maybe_run_password_helper;

const AUTH_OPTIONS: &[&str] = &[
    "BatchMode=no",
    "PreferredAuthentications=password",
    "PasswordAuthentication=yes",
    "NumberOfPasswordPrompts=1",
    "PubkeyAuthentication=no",
    "IdentityAgent=none",
    "KbdInteractiveAuthentication=no",
    crate::config::GSSAPI_INERT_OVERRIDE,
    "HostbasedAuthentication=no",
    #[cfg(target_os = "macos")]
    "UseKeychain=no",
];

/// Fixture-only keyboard-interactive destination. It exists so a live run can
/// prove the U2 refusal; it is never selected by product configuration.
const KEYBOARD_INTERACTIVE_OPTIONS: &[&str] = &[
    "BatchMode=no",
    "PreferredAuthentications=keyboard-interactive",
    "PasswordAuthentication=no",
    "NumberOfPasswordPrompts=1",
    "PubkeyAuthentication=no",
    "IdentityAgent=none",
    "KbdInteractiveAuthentication=yes",
    crate::config::GSSAPI_INERT_OVERRIDE,
    "HostbasedAuthentication=no",
    #[cfg(target_os = "macos")]
    "UseKeychain=no",
];

fn auth_options() -> &'static [&'static str] {
    if std::env::var_os("BIGBUD_SSH_OWNER_KEYBOARD_INTERACTIVE_PROOF").as_deref()
        == Some(std::ffi::OsStr::new("approved-disposable"))
    {
        KEYBOARD_INTERACTIVE_OPTIONS
    } else {
        AUTH_OPTIONS
    }
}
// At most 512 bytes including the final newline on the private helper pipe.
const PASSWORD_CAP: usize = 511;

fn valid_password(bytes: &[u8]) -> bool {
    (1..=PASSWORD_CAP).contains(&bytes.len())
        && !bytes.iter().any(|byte| matches!(byte, 0 | b'\n' | b'\r'))
}

struct Secret<'a>(&'a mut [u8]);

impl Drop for Secret<'_> {
    fn drop(&mut self) {
        for byte in self.0.iter_mut() {
            // SAFETY: each byte is initialized and exclusively borrowed. The
            // volatile write keeps the wipe observable even after last use.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

#[cfg(any(test, target_os = "linux"))]
impl PosixMasterSlot {
    /// Requires explicit approval by the startup-bound disposable picker lane.
    /// The passed bytes are always wiped (including refusal and early failure).
    pub(in super::super::super) fn unlock_password(
        &mut self,
        transport: &Transport,
        generation: Token,
        password: &mut [u8],
        deadline: Instant,
    ) -> Result<(), ErrorCode> {
        let secret = Secret(password);
        if !valid_password(secret.0) {
            return Err(ErrorCode::OperationDenied);
        }
        // U2: refuse from method configuration before any listener or release.
        let options = auth_options();
        super::super::auth_methods::admit(options)?;
        if self.master.is_some() {
            let master = self.admit(transport, generation)?;
            if !master.binding.password {
                return Err(ErrorCode::OperationDenied);
            }
            drop(secret);
            let result = master.connect(transport, deadline).map(drop);
            return self.finish_check(generation, result);
        }
        let ready_by = deadline.min(Instant::now() + READY_LIMIT);
        if Instant::now() >= ready_by {
            return Err(LOST);
        }
        let root = fixture_root(transport)?;
        let mut command = self.prepare(
            transport,
            generation,
            || PrivatePaths::new_in(root),
            options,
        )?;
        let master = self.master.as_mut().ok_or(UNAVAILABLE)?;
        let result = (|| {
            let mut askpass = askpass::Listener::new(&master.paths)?;
            let result = (|| {
                askpass.configure(&mut command, transport)?;
                master.spawn(&mut command, ready_by)?;
                await_password(master, transport, &mut askpass, secret, ready_by)
            })();
            askpass.close(&master.paths)?;
            result
        })();
        self.finish_check(generation, result)
    }

    /// Use only the exact generation's already verified password master. No
    /// implicit authentication, direct list, or fall back to a key master.
    pub(in super::super::super) fn list_unlocked_folders(
        &mut self,
        transport: &Transport,
        generation: Token,
        path: Option<&str>,
        deadline: Instant,
    ) -> Result<Folders, ErrorCode> {
        let picker = session::Picker::new(path)?;
        if Instant::now() >= deadline {
            return Err(ErrorCode::ListTimedOut);
        }
        if self.master.is_none() {
            return Err(ErrorCode::AuthRequired);
        }
        self.list(transport, generation, picker, deadline, true)
    }
}

#[cfg(any(test, target_os = "linux"))]
fn await_password(
    master: &mut Master,
    transport: &Transport,
    askpass: &mut askpass::Listener,
    secret: Secret<'_>,
    deadline: Instant,
) -> Result<(), ErrorCode> {
    let mut secret = Some(secret);
    while Instant::now() < deadline {
        let ssh = master.live_pid()?;
        if master.paths.observe()?.is_some() {
            master.verify(deadline.min(Instant::now() + CHECK_LIMIT))?;
            // "none" auth or other silent success is not password proof.
            if secret.is_some() {
                return Err(ErrorCode::AuthRequired);
            }
            return master.binding.revalidate(transport);
        }
        if let Some(helper) = askpass.accept(ssh)? {
            let secret = secret.take().ok_or(ErrorCode::AuthRequired)?;
            master.binding.revalidate(transport)?;
            if master.live_pid()? != ssh {
                return Err(UNAVAILABLE);
            }
            // Remove the endpoint before releasing anything. Only this exact
            // connected fd survives, not a listener for subsequent prompts.
            askpass.close(&master.paths)?;
            askpass::release(helper, secret, deadline.min(Instant::now() + CHECK_LIMIT))?;
        }
        pause(deadline);
    }
    Err(LOST)
}

#[cfg(any(test, target_os = "linux"))]
fn fixture_root(transport: &Transport) -> Result<&Path, ErrorCode> {
    let config = &transport.config;
    let unsupported = ErrorCode::ConfigUnsupported;
    let root = config.identity.parent().ok_or(unsupported)?;
    #[cfg(target_os = "macos")]
    let (parent, prefix) = ("/private/tmp", "bigbud-picker-sshd-");
    #[cfg(target_os = "linux")]
    let (parent, prefix) = ("/tmp", "bigbud-picker-linux-");
    #[cfg(target_os = "linux")]
    if config.user != "picker" || config.port != 22222 {
        return Err(unsupported);
    }
    let valid_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(prefix))
        .is_some_and(|suffix| {
            (1..=64).contains(&suffix.len()) && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
        });
    if root.parent() != Some(Path::new(parent))
        || !valid_name
        || config.identity != root.join("identity")
        || config.known_hosts != root.join("known_hosts")
        || config.host != Ipv4Addr::LOCALHOST
        || config.port < 1024
        || config.alias_config.is_some()
        || config.system_config.is_some()
        || config.workspace_root.is_some()
        || config.dev_interactive_terminal
    {
        return Err(unsupported);
    }
    Ok(root)
}

#[cfg(any(test, target_os = "linux"))]
pub(super) fn validate_target(transport: &Transport) -> Result<(), ErrorCode> {
    let root = fixture_root(transport)?;
    #[cfg(target_os = "linux")]
    {
        transport.images.require_mounted_linux_fixture()?;
        paths::linux_fixture_parent(root.parent().ok_or(UNAVAILABLE)?)?;
    }
    #[cfg(target_os = "macos")]
    let _checked_shape = root;
    Ok(())
}
