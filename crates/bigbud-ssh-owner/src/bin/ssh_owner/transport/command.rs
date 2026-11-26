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
    /// A master's own pinned command: always a direct connection that
    /// authenticates itself, never routed over another master.
    pub(super) fn pinned_master_ssh(&self, tty: &str) -> Result<PinnedSsh, ErrorCode> {
        let pin = self.pin()?.ok_or(ErrorCode::TrustRequired)?;
        self.require_direct_route()?;
        self.build_ssh_with_route(tty, None, false, &pin, HostVerification::Ed25519Key, true)
    }

    pub(super) fn build_ssh_for_pin(
        &self,
        tty: &str,
        timers: Option<&SshTimers>,
        fixed_forward: bool,
        pin: &trust_store::Pin,
        verification: HostVerification,
    ) -> Result<PinnedSsh, ErrorCode> {
        self.build_ssh_with_route(tty, timers, fixed_forward, pin, verification, false)
    }

    /// `direct` is only for a master's own command. Every other command of a
    /// credential target multiplexes over its unlocked master, or is refused
    /// typed (`credential_required`) before any SSH process starts.
    pub(super) fn build_ssh_with_route(
        &self,
        tty: &str,
        timers: Option<&SshTimers>,
        fixed_forward: bool,
        pin: &trust_store::Pin,
        verification: HostVerification,
        direct: bool,
    ) -> Result<PinnedSsh, ErrorCode> {
        let mux = if direct {
            None
        } else {
            self.credential_route()?
        };
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
        ] {
            ssh.args(["-o", option]);
        }
        // U23: exactly the pinned key types (ed25519 first, RSA only SHA-2);
        // a certificate keeps its fixed algorithm.
        match verification {
            HostVerification::Ed25519Key => ssh.args(["-o", &pin.host_key_algorithms()]),
            HostVerification::Ed25519Certificate => ssh.args(["-o", verification.option()]),
        };
        auth_methods::admit(AUTH_METHOD_OPTIONS)?;
        for option in AUTH_METHOD_OPTIONS {
            ssh.args(["-o", option]);
        }
        // A credential target's unlocked master carries this command; the
        // client never authenticates on its own and never becomes a master.
        let mut control_path = std::ffi::OsString::from("ControlPath=");
        match &mux {
            Some(path) => control_path.push(path),
            None => control_path.push("none"),
        }
        ssh.arg("-o").arg(control_path);
        for option in [
            "ProxyCommand=none",
            "ProxyJump=none",
            "CanonicalizeHostname=no",
            "ControlMaster=no",
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
