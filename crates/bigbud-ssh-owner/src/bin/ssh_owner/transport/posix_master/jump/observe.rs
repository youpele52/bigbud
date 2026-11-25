//! Credential-free observation through the already admitted prefix. OpenSSH's
//! fixed lookup child records only the presented Ed25519 key and returns no
//! known-host records. Strict host verification therefore stops before auth.

use super::*;
use crate::transport::host_key;
use std::{
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    process::{Child, ExitCode},
};

const EXECUTABLE: &str = "/test-binary";
const FLAG: &str = "--observe-fixture-jump-host-key";
const OPT_IN: &str = "BIGBUD_JUMP_KEY_OBSERVER";
const RECORD: &str = "host-key-observation";

impl Route {
    pub(in crate::transport) fn observe(
        &mut self,
        prefix: &[&Transport],
        pending: &Transport,
        deadline: Instant,
    ) -> Result<HostKey, ErrorCode> {
        let root = self.lease_root.clone().ok_or(UNAVAILABLE)?;
        if !self.legs.is_empty() || prefix.len() >= MAX_LEGS {
            return Err(UNAVAILABLE);
        }
        paths::require_no_residual_lease(&root)?;
        let result = (|| {
            for transport in prefix.iter().copied().chain(std::iter::once(pending)) {
                transport.images.require_mounted_linux_fixture()?;
                validate_fixture_for_auth(transport, false)?;
            }
            self.start(prefix, deadline)
                .map_err(|failure| failure.code)?;
            let forward = match (self.legs.last_mut(), prefix.last()) {
                (Some((slot, _)), Some(prior)) => {
                    let control = slot
                        .admit(prior, self.generation)?
                        .connect(prior, deadline)?;
                    let endpoint = SocketAddr::new(pending.config.host, pending.config.port);
                    Some(session::forward::open_forward(control, endpoint, deadline)?)
                }
                (None, None) => None,
                _ => return Err(UNAVAILABLE),
            };
            probe(pending, &root, forward, deadline)
        })();
        self.retire().map_err(|failure| failure.code)?;
        result
    }
}

fn observer_image() -> bool {
    let exe = std::env::current_exe();
    exe.as_deref()
        .is_ok_and(|path| path == Path::new(EXECUTABLE))
        && fs::symlink_metadata(EXECUTABLE)
            .is_ok_and(|metadata| metadata.is_file() && metadata.mode() & 0o6022 == 0)
}

fn probe(
    pending: &Transport,
    root: &Path,
    forward: Option<(session::forward::ForwardIo, UnixStream)>,
    deadline: Instant,
) -> Result<HostKey, ErrorCode> {
    if !observer_image() {
        return Err(UNAVAILABLE);
    }
    let mut command = pending.images.ssh()?;
    let capture = PrivatePaths::new_in_route(root)?;
    let output = capture.socket.with_file_name(RECORD);
    let result = (|| {
        let output_arg = output
            .to_str()
            .filter(|path| safe_capture_path(path))
            .ok_or(UNAVAILABLE)?;
        command
            .env_clear()
            .env("LC_ALL", "C")
            .env(OPT_IN, "1")
            .args([pending.family, "-N", "-T", "-F", "/dev/null", "-p"])
            .arg(pending.config.port.to_string())
            .args(["-l", "probe"])
            .args([
                "-o",
                &format!("KnownHostsCommand={EXECUTABLE} {FLAG} {output_arg} %I %t %K"),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for option in [
            "StrictHostKeyChecking=yes",
            "UserKnownHostsFile=none",
            "GlobalKnownHostsFile=none",
            "UpdateHostKeys=no",
            "CheckHostIP=no",
            "VerifyHostKeyDNS=no",
            "NoHostAuthenticationForLocalhost=no",
            "HostKeyAlgorithms=ssh-ed25519",
            "IdentityFile=none",
            "CertificateFile=none",
            "IdentityAgent=none",
            "BatchMode=yes",
            "PubkeyAuthentication=no",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "GSSAPIAuthentication=no",
            "HostbasedAuthentication=no",
            "ControlMaster=no",
            "ControlPath=none",
            "ControlPersist=no",
            "ClearAllForwardings=yes",
            "ConnectTimeout=8",
            "ConnectionAttempts=1",
        ] {
            command.args(["-o", option]);
        }
        let forwarded = forward.map(|(io, control)| {
            command
                .args(["-o", "ProxyCommand=-"])
                .stdin(Stdio::from(io.input))
                .stdout(Stdio::from(io.output));
            control
        });
        command.args(["-o", "ProxyJump=none", "--", pending.host()]);
        if Instant::now() >= deadline {
            return Err(LOST);
        }
        let mut child = command.spawn().map_err(|_| UNAVAILABLE)?;
        drop(command);
        let result = wait(&mut child, deadline);
        drop(forwarded);
        result?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&output)
            .map_err(|_| LOST)?;
        let mut bytes = Vec::new();
        file.take(97).read_to_end(&mut bytes).map_err(|_| LOST)?;
        HostKey::from_record(&bytes, "observed").ok_or(LOST)
    })();
    // If our exact child could not be reaped, retain the private reservation
    // so a new route cannot start over unconfirmed ownership.
    if matches!(result, Err(ErrorCode::OutcomeUnknown)) {
        return result;
    }
    match fs::remove_file(&output) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err(UNAVAILABLE),
    }
    capture.remove(None)?;
    result
}

fn wait(child: &mut Child, deadline: Instant) -> Result<(), ErrorCode> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.code() == Some(255) => return Ok(()),
            Ok(Some(_)) => return Err(LOST),
            Ok(None) if Instant::now() < deadline => pause(deadline),
            _ => {
                let _ = child.kill();
                let end = Instant::now() + REAP_LIMIT;
                while Instant::now() < end {
                    if child.try_wait().is_ok_and(|status| status.is_some()) {
                        return Err(LOST);
                    }
                    pause(end);
                }
                return Err(ErrorCode::OutcomeUnknown);
            }
        }
    }
}

fn safe_capture_path(path: &str) -> bool {
    let Some((root, rest)) = path
        .strip_prefix("/tmp/bigbud-picker-linux-")
        .and_then(|path| path.split_once("/bbcm-"))
    else {
        return false;
    };
    let Some(id) = rest.strip_suffix("/host-key-observation") else {
        return false;
    };
    !root.is_empty()
        && root.len() <= 64
        && root.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && id.len() == 12
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

pub(crate) fn maybe_observe_key() -> Option<ExitCode> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(FLAG)) {
        return None;
    }
    let result = (|| {
        if std::env::var_os(OPT_IN).as_deref() != Some(OsStr::new("1")) || !observer_image() {
            return None;
        }
        let output = args.next()?.into_string().ok()?;
        let mode = args.next()?.into_string().ok()?;
        let kind = args.next()?.into_string().ok()?;
        let key = args.next()?.into_string().ok()?;
        if args.next().is_some() || !safe_capture_path(&output) {
            return None;
        }
        if mode == "ORDER" && kind == "NONE" && key == "NONE" {
            return Some(());
        }
        if mode != "HOSTNAME" || kind != host_key::TYPE || key.len() != 68 {
            return None;
        }
        let record = format!("observed {kind} {key}\n");
        HostKey::from_record(record.as_bytes(), "observed")?;
        let parent = fs::symlink_metadata(Path::new(&output).parent()?).ok()?;
        if !parent.is_dir() || parent.uid() != paths::uid() || parent.mode() & 0o777 != 0o700 {
            return None;
        }
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(output)
            .ok()?
            .write_all(record.as_bytes())
            .ok()
    })();
    Some(if result.is_some() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}
