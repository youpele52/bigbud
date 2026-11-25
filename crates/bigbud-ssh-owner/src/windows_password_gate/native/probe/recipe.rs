use super::{GuardedLocalFile, GuardedLocalPath, TargetGeneration, denied};
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    io::{self, Read},
    os::windows::ffi::OsStringExt,
    path::{Path, PathBuf},
};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

const HOST: &str = "127.0.0.1";
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// The authoritative owner stamps a local, disposable target after explicit
/// host-key approval. `approved_ed25519` is the 68-character SSH wire blob in
/// standard Base64, not observed data obtained during this launch.
pub struct LoopbackPasswordTarget<'a> {
    pub generation: TargetGeneration<'a>,
    pub port: u16,
    pub user: &'a str,
    pub approved_ed25519: &'a str,
}

/// Expected digests must come from the independently verified launch context,
/// never from reading a user-supplied candidate image during preparation.
pub struct PasswordProbeFiles<'a> {
    pub inbox_ssh_sha256: [u8; 32],
    pub helper_image: &'a Path,
    pub helper_sha256: [u8; 32],
    pub known_hosts: &'a Path,
}

pub(super) struct Recipe {
    pub(super) system: PathBuf,
    pub(super) ssh: GuardedLocalFile,
    pub(super) helper: GuardedLocalFile,
    _trust: GuardedLocalFile,
    pub(super) args: Vec<OsString>,
    #[cfg(test)]
    pub(super) omit_askpass_trigger: Option<&'static str>,
}

impl Recipe {
    pub(super) fn prepare(
        target: &LoopbackPasswordTarget<'_>,
        files: &PasswordProbeFiles<'_>,
    ) -> io::Result<Self> {
        let pin = expected_record(target)?;
        let trust_path = GuardedLocalPath::new(files.known_hosts)?;
        let mut trust = trust_path.open(false)?;
        let mut actual = Vec::with_capacity(pin.len() + 1);
        trust
            .file_mut()
            .take((pin.len() + 1) as u64)
            .read_to_end(&mut actual)?;
        if actual != pin.as_bytes() {
            return Err(denied());
        }
        let system = inbox_system_directory()?;
        let ssh = image(
            &system.join("OpenSSH").join("ssh.exe"),
            files.inbox_ssh_sha256,
        )?;
        let helper = image(files.helper_image, files.helper_sha256)?;
        if !helper
            .dos_path()
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.eq_ignore_ascii_case("bigbud-ssh-password-helper.exe"))
        {
            return Err(denied());
        }
        Ok(Self {
            system,
            ssh,
            helper,
            _trust: trust,
            args: arguments(target.user, target.port, trust_path.as_str()),
            #[cfg(test)]
            omit_askpass_trigger: None,
        })
    }
    #[cfg(test)]
    pub(super) fn fixture(image: &GuardedLocalPath, test: &str) -> io::Result<Self> {
        // Never exposed by the launcher: tests exercise the same process
        // graph without claiming real inbox compatibility.
        Ok(Self {
            system: inbox_system_directory()?,
            ssh: image.open(false)?,
            helper: image.open(false)?,
            _trust: image.open(false)?,
            args: ["--exact", test, "--quiet"].map(OsString::from).to_vec(),
            omit_askpass_trigger: None,
        })
    }
}

#[doc(hidden)]
pub fn inbox_system_directory() -> io::Result<PathBuf> {
    let mut buffer = [0u16; 260];
    // SAFETY: live writable buffer of the advertised UTF-16 length.
    let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    buffer
        .get(..len)
        .filter(|_| len > 0 && len < buffer.len())
        .map(OsString::from_wide)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.parent().is_some())
        .ok_or_else(denied)
}

fn image(path: &Path, expected: [u8; 32]) -> io::Result<GuardedLocalFile> {
    let mut file = GuardedLocalPath::new(path)?.open(false)?;
    let len = file.file_mut().metadata()?.len();
    if !(1..=MAX_IMAGE_BYTES).contains(&len) {
        return Err(denied());
    }
    let mut digest = Sha256::new();
    if io::copy(&mut file.file_mut().take(MAX_IMAGE_BYTES + 1), &mut digest)? != len
        || digest.finalize().as_slice() != expected
    {
        return Err(denied());
    }
    Ok(file)
}

pub(super) fn expected_record(target: &LoopbackPasswordTarget<'_>) -> io::Result<String> {
    let user = target.user.as_bytes();
    let key = target.approved_ed25519;
    // The first 25 characters are fixed by the length, type and key length.
    // The next digit is A..P because only four bits come from the key.
    const PREFIX: &str = "AAAAC3NzaC1lZDI1NTE5AAAAI";
    if target.generation.target.is_empty()
        || !valid_target(user, target.port)
        || key.len() != 68
        || !key
            .strip_prefix(PREFIX)
            .and_then(|part| part.as_bytes().first())
            .is_some_and(|byte| matches!(byte, b'A'..=b'P'))
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return Err(denied());
    }
    let label = if target.port == 22 {
        HOST.to_owned()
    } else {
        format!("[{HOST}]:{}", target.port)
    };
    Ok(format!("{label} ssh-ed25519 {key}\n"))
}

fn valid_target(user: &[u8], port: u16) -> bool {
    port != 0
        && user.len() <= 64
        && user.first().is_some_and(u8::is_ascii_alphanumeric)
        && user
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn arguments(user: &str, port: u16, trust: &str) -> Vec<OsString> {
    let mut args = ["-4", "-T", "-n", "-F", "NUL", "-p"]
        .map(OsString::from)
        .to_vec();
    args.extend([port.to_string().into(), "-l".into(), user.into()]);
    args.extend([
        "-o".into(),
        format!("UserKnownHostsFile=\"{trust}\"").into(),
    ]);
    for option in [
        "GlobalKnownHostsFile=NUL",
        "StrictHostKeyChecking=yes",
        "CheckHostIP=no",
        "VerifyHostKeyDNS=no",
        "UpdateHostKeys=no",
        "HostKeyAlgorithms=ssh-ed25519",
        "BatchMode=no",
        "PreferredAuthentications=password",
        "PasswordAuthentication=yes",
        "NumberOfPasswordPrompts=1",
        "PubkeyAuthentication=no",
        "HostbasedAuthentication=no",
        // The spelling accepted by inbox OpenSSH 8.1p1.
        "ChallengeResponseAuthentication=no",
        "IdentityAgent=none",
        "ControlMaster=no",
        "ProxyCommand=none",
        "ProxyJump=none",
        "PermitLocalCommand=no",
        "ClearAllForwardings=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ConnectionAttempts=1",
        "ConnectTimeout=10",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    args.extend(["--", HOST, "true"].map(OsString::from));
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIN: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn exact_record_has_no_wildcards_alternates_or_ambient_host_labels() {
        let mut target = LoopbackPasswordTarget {
            generation: TargetGeneration {
                target: "isolated",
                generation: 4,
            },
            port: 2222,
            user: "test-user",
            approved_ed25519: PIN,
        };
        assert_eq!(
            expected_record(&target).unwrap(),
            format!("[127.0.0.1]:2222 ssh-ed25519 {PIN}\n")
        );
        target.port = 22;
        assert!(expected_record(&target).unwrap().starts_with("127.0.0.1 "));
        target.user = "-F";
        assert!(expected_record(&target).is_err());
        target.user = "test-user";
        let extra = format!("{PIN}\n*");
        target.approved_ed25519 = &extra;
        assert!(expected_record(&target).is_err());
    }

    #[test]
    fn password_probe_has_one_fixed_target_and_no_ambient_ssh_config() {
        let args = arguments("owner", 2222, "C:/bigbud fixture/pin");
        assert!(args.starts_with(&["-4", "-T", "-n", "-F", "NUL"].map(OsString::from)));
        assert!(args.ends_with(&["--", "127.0.0.1", "true"].map(OsString::from)));
        for option in [
            "StrictHostKeyChecking=yes",
            "UpdateHostKeys=no",
            "HostKeyAlgorithms=ssh-ed25519",
            "PreferredAuthentications=password",
            "PubkeyAuthentication=no",
            "ChallengeResponseAuthentication=no",
            "NumberOfPasswordPrompts=1",
            "IdentityAgent=none",
            "ProxyCommand=none",
            "ProxyJump=none",
            "ControlMaster=no",
            "ClearAllForwardings=yes",
            "UserKnownHostsFile=\"C:/bigbud fixture/pin\"",
        ] {
            assert!(args.windows(2).any(|pair| pair == ["-o", option]));
        }
    }
}
