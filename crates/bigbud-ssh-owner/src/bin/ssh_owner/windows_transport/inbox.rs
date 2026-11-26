use super::{ErrorCode, FixturePath, HOST};
use bigbud_ssh_owner::windows_password_gate::native::probe::inbox_system_directory;
use std::{os::windows::process::CommandExt, path::PathBuf, process::Command};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

pub(super) struct Inbox {
    system: PathBuf,
}

impl Inbox {
    pub(super) fn resolve() -> Result<Self, ErrorCode> {
        let system = inbox_system_directory().map_err(|_| ErrorCode::OwnerUnavailable)?;
        Ok(Self { system })
    }

    fn command(&self, image: &str) -> Command {
        let mut command = Command::new(self.system.join("OpenSSH").join(image));
        command
            .env_clear()
            .current_dir(&self.system)
            .creation_flags(CREATE_NO_WINDOW);
        if let Some(windows) = self.system.parent() {
            command.env("SystemRoot", windows);
        }
        command
    }

    pub(super) fn keyscan(&self, port: u16) -> Command {
        let mut scanner = self.command("ssh-keyscan.exe");
        scanner
            .args(["-4", "-T", "10", "-t", "ed25519", "-p"])
            .arg(port.to_string())
            .arg(HOST);
        scanner
    }

    pub(super) fn ssh(
        &self,
        port: u16,
        user: &str,
        identity: &FixturePath,
        known_hosts: &FixturePath,
        remote: &str,
    ) -> Command {
        let mut ssh = self.command("ssh.exe");
        ssh.args(["-4", "-T", "-n", "-F", "NUL", "-p"])
            .arg(port.to_string())
            .args(["-l", user, "-i", identity.as_str(), "-o"])
            .arg(format!("UserKnownHostsFile=\"{}\"", known_hosts.as_str()));
        for option in [
            "GlobalKnownHostsFile=NUL",
            "StrictHostKeyChecking=yes",
            "CheckHostIP=no",
            "VerifyHostKeyDNS=no",
            "UpdateHostKeys=no",
            "HostKeyAlgorithms=ssh-ed25519",
            "BatchMode=yes",
            "PreferredAuthentications=publickey",
            // Use the option spellings available before OpenSSH 8.5/8.7.
            // U22: the shared list, minus security-key forms the 8.1 inbox lacks.
            concat!(
                "PubkeyAcceptedKeyTypes=",
                user_auth_core!(),
                ",",
                user_auth_rsa!()
            ),
            "ChallengeResponseAuthentication=no",
            "IdentitiesOnly=yes",
            "IdentityAgent=none",
            "CertificateFile=none",
            "AddKeysToAgent=no",
            "PasswordAuthentication=no",
            "ProxyCommand=none",
            "PermitLocalCommand=no",
            "ClearAllForwardings=yes",
            "ForwardAgent=no",
            "ForwardX11=no",
            "ConnectTimeout=10",
            "ConnectionAttempts=1",
        ] {
            ssh.args(["-o", option]);
        }
        ssh.args(["--", HOST, remote]);
        ssh
    }
}

#[cfg(test)]
impl Inbox {
    pub(super) fn for_test() -> Self {
        Self {
            system: PathBuf::from(r"C:\Windows\System32"),
        }
    }
}
