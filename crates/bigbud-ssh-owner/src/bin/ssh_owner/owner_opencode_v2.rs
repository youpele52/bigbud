//! Owner-selected OpenCode v2 service recipe.
//!
//! OpenCode v2 differs from v1: it announces readiness as one JSON line on
//! stdout, treats stdin EOF as its ownership lease, and protects every server
//! with an explicit password. The owner therefore selects the executable, the
//! `serve` argv, the remote loopback port, the local listener, the forward spec
//! and the per-lease credential. The request contributes only the authorized
//! workspace and session identity.

#[path = "owner_opencode_v2/probe.rs"]
mod probe;
#[path = "owner_opencode_v2/startup.rs"]
mod startup;
#[cfg(test)]
#[path = "owner_opencode_v2/tests.rs"]
mod tests;

use super::owner_opencode_v1::exact_path;
use super::{random_token, transport::PinnedSsh, v1::ProviderServiceScope};
use crate::owner_opencode::{Outcome, ReadyPort, hex, quote, run as run_session, unavailable};
use startup::Startup;
use std::{
    io,
    net::{Ipv4Addr, SocketAddrV4},
};

pub(crate) const RECEIPT_TAG: &str = "bigbud-opencode-v2";
const REAP_WORKER: &str = "proof-opencode-v2-reap";
/// The only remote host OpenCode v2 may bind; never taken from a request.
const REMOTE_HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
/// Owner-selected remote port range for the v2 listener.
const REMOTE_PORT_BASE: u16 = 49_152;
const REMOTE_PORT_SPAN: u16 = 16_384;

const LAUNCH: &str = concat!(
    r#"
[[ $# == 6 ]] || exit 126
binary=$1 cwd=$2 nonce=$3 host=$4 port=$5 supervisor=$6
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'
"#,
    include_str!("owner_agent_proxy/provider_service_guard.sh"),
    r#"
validate 2>/dev/null || exit 126
[[ -x /usr/bin/python3 ]] || exit 126
unset PWD OLDPWD
exec /usr/bin/python3 -I -c "$supervisor" "$cwd" "$nonce" "$host" "$port"
"#,
);

fn invalid_scope() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid OpenCode v2 service binding",
    )
}

#[derive(Debug)]
pub(crate) struct ProductRecipe {
    binary: String,
    root: String,
}

impl ProductRecipe {
    pub(crate) fn new(binary: &std::path::Path, root: &std::path::Path) -> io::Result<Self> {
        let binary = exact_path(binary).map_err(|_| invalid_scope())?;
        let root = exact_path(root).map_err(|_| invalid_scope())?;
        if root == "/" || binary == root {
            return Err(invalid_scope());
        }
        Ok(Self {
            binary: binary.to_owned(),
            root: root.to_owned(),
        })
    }

    pub(crate) fn matches(&self, scope: &ProviderServiceScope) -> bool {
        scope.cwd == self.root
            && !scope.thread_id.is_empty()
            && scope.thread_id.len() <= 128
            && scope.thread_id.bytes().all(|byte| byte.is_ascii_graphic())
    }

    pub(crate) fn run(
        &self,
        pinned: PinnedSsh,
        host: &str,
        publish: impl FnOnce(ReadyPort) -> bool,
        cancelled: impl Fn() -> bool,
    ) -> Outcome {
        let Ok(nonce) = random_token() else {
            return unavailable();
        };
        let Ok(port_token) = random_token() else {
            return unavailable();
        };
        let nonce = hex(&nonce);
        let remote = SocketAddrV4::new(REMOTE_HOST, remote_port(&port_token));
        let Ok(mut startup) = Startup::reserve(remote) else {
            return unavailable();
        };
        let command = self.remote_command(&nonce, remote);
        let outcome = run_session(
            pinned,
            host,
            &command,
            remote,
            REAP_WORKER,
            RECEIPT_TAG,
            &nonce,
            &mut startup,
            publish,
            &cancelled,
        );
        drop(startup);
        outcome
    }

    fn remote_command(&self, nonce: &str, remote: SocketAddrV4) -> String {
        format!(
            "exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\" PATH=/usr/bin:/bin /bin/bash -o pipefail -c {} bigbud-opencode-v2 {} {} {} {} {} {}",
            quote(LAUNCH),
            quote(&self.binary),
            quote(&self.root),
            quote(nonce),
            remote.ip(),
            remote.port(),
            quote(include_str!("owner_opencode_v2/supervise.py")),
        )
    }
}

/// Deterministic mapping from an owner-generated token to the remote port. It
/// is not a security boundary; it only keeps two live targets from choosing the
/// same remote port by accident.
fn remote_port(token: &[u8; 32]) -> u16 {
    let value = (u16::from(token[0]) << 8) | u16::from(token[1]);
    REMOTE_PORT_BASE + value % REMOTE_PORT_SPAN
}
