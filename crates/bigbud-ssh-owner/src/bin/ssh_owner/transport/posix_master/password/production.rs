//! Production credential master (v1.credential.proto): the target's own
//! verified master, authenticated once with an in-app password or key
//! passphrase through the owner's askpass helper.
//!
//! The secret is released at most once, to the verified helper whose parent is
//! this exact `ssh`, and is wiped on every path. Nothing is cached: when the
//! master ends, a new entry is needed. Keyboard-interactive is never eligible
//! (U2), decided from the method options below.

use super::super::{
    CHECK_LIMIT, ErrorCode, LOST, Master, PosixMasterSlot, PrivatePaths, READY_LIMIT, Transport,
    TrustRead, UNAVAILABLE, pause,
};
use super::{Secret, askpass, auth_options, valid_password};
use crate::Token;
use std::{
    ffi::OsString,
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::Path,
    time::Instant,
};

const PASSPHRASE_OPTIONS: &[&str] = &[
    "BatchMode=no",
    "PreferredAuthentications=publickey",
    "PubkeyAuthentication=yes",
    "PasswordAuthentication=no",
    "NumberOfPasswordPrompts=1",
    "IdentityAgent=none",
    "KbdInteractiveAuthentication=no",
    crate::config::GSSAPI_INERT_OVERRIDE,
    "HostbasedAuthentication=no",
    #[cfg(target_os = "macos")]
    "UseKeychain=no",
];

/// OpenSSH's `load_identity_file` prompt: `%.100s` keeps the first 100 bytes
/// of the `-i` path, so the prompt is built from bytes, not characters.
fn passphrase_prompt(identity: &Path) -> OsString {
    let bytes = identity.as_os_str().as_bytes();
    let mut prompt = b"Enter passphrase for key '".to_vec();
    prompt.extend_from_slice(bytes.get(..100).unwrap_or(bytes));
    prompt.extend_from_slice(b"': ");
    OsString::from_vec(prompt)
}

impl PosixMasterSlot {
    /// Opens the production master with the given secret. An already open
    /// master of this generation is the unlocked state; the secret is wiped
    /// unused. A rejected secret settles `credential_rejected`.
    pub(in super::super::super::super) fn unlock_production_credential(
        &mut self,
        transport: &Transport,
        generation: Token,
        passphrase: bool,
        secret: &mut [u8],
        deadline: Instant,
        root: &Path,
    ) -> Result<(), ErrorCode> {
        let secret = Secret(secret);
        if !valid_password(secret.0) {
            return Err(ErrorCode::InvalidOperands);
        }
        let options = if passphrase {
            PASSPHRASE_OPTIONS
        } else {
            auth_options()
        };
        super::super::super::auth_methods::admit(options)?;
        if let Some(master) = &self.master {
            if master.binding.generation != generation {
                return Err(ErrorCode::StaleGeneration);
            }
            return Ok(());
        }
        let prompt = if passphrase {
            passphrase_prompt(transport.credential_identity().ok_or(UNAVAILABLE)?)
        } else {
            OsString::from(format!(
                "{}@{}'s password: ",
                transport.config.user,
                transport.host()
            ))
        };
        let ready_by = deadline.min(Instant::now() + READY_LIMIT);
        let mut command = self.prepare_with(
            transport,
            generation,
            || PrivatePaths::new_owner_private(root),
            options,
            TrustRead::Default,
            true,
        )?;
        let master = self.master.as_mut().ok_or(UNAVAILABLE)?;
        let result = (|| {
            let mut askpass = askpass::Listener::new(&master.paths)?;
            let result = (|| {
                askpass.configure_prompt(&mut command, &prompt)?;
                master.spawn(&mut command, ready_by)?;
                exchange(master, transport, &mut askpass, secret, ready_by)
            })();
            askpass.close(&master.paths)?;
            result
        })();
        self.finish_check(generation, result)?;
        let master = self.master.as_mut().ok_or(UNAVAILABLE)?;
        let mux = transport.credential_mux().clone();
        mux.publish(master.paths.socket.clone());
        master.published = Some(mux);
        Ok(())
    }
}

fn exchange(
    master: &mut Master,
    transport: &Transport,
    askpass: &mut askpass::Listener,
    secret: Secret<'_>,
    deadline: Instant,
) -> Result<(), ErrorCode> {
    let mut secret = Some(secret);
    while Instant::now() < deadline {
        let ssh = match master.live_pid() {
            Ok(pid) => pid,
            // The client exited after the one release: the server refused it.
            Err(_) if secret.is_none() => return Err(ErrorCode::CredentialRejected),
            Err(error) => return Err(error),
        };
        if master.paths.observe()?.is_some() {
            master.verify(deadline.min(Instant::now() + CHECK_LIMIT))?;
            // Silent success without the secret is not credential proof.
            if secret.is_some() {
                return Err(ErrorCode::AuthRequired);
            }
            return master.binding.revalidate(transport);
        }
        if let Some(helper) = askpass.accept(ssh)? {
            // One prompt only (`NumberOfPasswordPrompts=1`).
            let secret = secret.take().ok_or(ErrorCode::CredentialRejected)?;
            master.binding.revalidate(transport)?;
            if master.live_pid()? != ssh {
                return Err(UNAVAILABLE);
            }
            askpass.close(&master.paths)?;
            askpass::release(helper, secret, deadline.min(Instant::now() + CHECK_LIMIT))?;
        }
        pause(deadline);
    }
    Err(LOST)
}

#[cfg(test)]
#[test]
fn passphrase_prompt_matches_openssh_truncation() {
    assert_eq!(
        passphrase_prompt(Path::new("/home/u/.ssh/id_ed25519")),
        OsString::from("Enter passphrase for key '/home/u/.ssh/id_ed25519': ")
    );
    let long = format!("/{}", "a".repeat(150));
    let expected = format!("Enter passphrase for key '/{}': ", "a".repeat(99));
    assert_eq!(
        passphrase_prompt(Path::new(&long)),
        OsString::from(expected)
    );
}
