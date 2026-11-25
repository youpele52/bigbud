//! Pinned SSH command construction for the direct route.
//!
//! Split from `transport.rs` to keep the transport module focused. The command
//! contains only this operation's exact trust snapshot; OpenSSH never reads an
//! ambient config or applies an algorithm fallback.

use super::{
    AUTH_METHOD_OPTIONS, DEADLINE, HostVerification, PinnedSsh, SshTimers, Transport, auth_methods,
    trust_store,
};
use crate::v1::ErrorCode;

impl Transport {
    pub(super) fn build_ssh_for_pin(
        &self,
        tty: &str,
        timers: Option<&SshTimers>,
        fixed_forward: bool,
        pin: &trust_store::Pin,
        verification: HostVerification,
    ) -> Result<PinnedSsh, ErrorCode> {
        // OpenSSH sees only this operation's exact trust record. The real
        // handshake validates it before user auth, with no algorithm fallback.
        let snapshot = trust_store::Snapshot::new(&self.config.known_hosts, pin)?;
        let known_hosts = format!("UserKnownHostsFile={}", snapshot.path().display());
        let mut ssh = self.images.ssh()?;
        ssh.args([self.family, tty, "-F", "/dev/null", "-p"])
            .arg(self.config.port.to_string())
            .arg("-l")
            .arg(&self.config.user);
        self.identities.apply_to(&mut ssh)?;
        self.apply_proof_agent(&mut ssh)?;
        ssh.args(["-o", &known_hosts]);
        for option in [
            "GlobalKnownHostsFile=none",
            "KnownHostsCommand=none",
            "StrictHostKeyChecking=yes",
            "CheckHostIP=no",
            "VerifyHostKeyDNS=no",
            "UpdateHostKeys=no",
            verification.option(),
        ] {
            ssh.args(["-o", option]);
        }
        auth_methods::admit(AUTH_METHOD_OPTIONS)?;
        for option in AUTH_METHOD_OPTIONS {
            ssh.args(["-o", option]);
        }
        for option in [
            "ProxyCommand=none",
            "ProxyJump=none",
            "CanonicalizeHostname=no",
            "ControlMaster=no",
            "ControlPath=none",
            "ControlPersist=no",
            "PermitLocalCommand=no",
            if fixed_forward {
                "ClearAllForwardings=no"
            } else {
                "ClearAllForwardings=yes"
            },
            "ForwardAgent=no",
            "ForwardX11=no",
        ] {
            ssh.args(["-o", option]);
        }
        // Only the S1 picker admits synthetic timing options. Other proof
        // lanes keep their existing SSH flags and deadline handling.
        if let Some(timers) = timers {
            timers.apply_to(&mut ssh, DEADLINE)?;
        } else {
            ssh.args([
                "-o",
                if fixed_forward {
                    "ConnectTimeout=8"
                } else {
                    "ConnectTimeout=10"
                },
            ]);
        }
        ssh.args(["-o", "ConnectionAttempts=1"]);
        if verification == HostVerification::Ed25519Certificate {
            ssh.args(["-o", "CASignatureAlgorithms=ssh-ed25519"]);
        }
        if self.host_label != self.scan_label
            || verification == HostVerification::Ed25519Certificate
        {
            ssh.arg("-o")
                .arg(format!("HostKeyAlias={}", self.host_label));
        }
        Ok(PinnedSsh {
            command: ssh,
            _snapshot: snapshot,
        })
    }
}
