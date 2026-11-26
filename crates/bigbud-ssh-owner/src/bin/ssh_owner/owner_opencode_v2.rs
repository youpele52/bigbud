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

use super::{random_token, transport::PinnedSsh, v1::ProviderServiceScope};
use crate::owner_opencode::{Outcome, ReadyPort, hex, quote, run as run_session, unavailable};
use startup::Startup;
use std::{
    io,
    net::{Ipv4Addr, SocketAddrV4},
    path::Path,
};

pub(crate) const RECEIPT_TAG: &str = "bigbud-opencode-v2";
const REAP_WORKER: &str = "proof-opencode-v2-reap";
/// The only remote host OpenCode v2 may bind; never taken from a request.
const REMOTE_HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
/// Owner-selected remote port range for the v2 listener.
const REMOTE_PORT_BASE: u16 = 49_152;
const REMOTE_PORT_SPAN: u16 = 16_384;
/// Size ceiling for the configured executable. The v2 CLI is a single bundled
/// binary (2.1.4 linux-arm64 is about 225 MiB), well above the v1 ceiling.
const LIMIT: u64 = 512 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 4095;

const LAUNCH: &str = concat!(
    r#"
[[ $# == 7 ]] || exit 126
configured=$1 cwd=$2 nonce=$3 host=$4 port=$5 supervisor=$6 limit=$7 binary=
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'
"#,
    include_str!("owner_agent_proxy/provider_service_guard.sh"),
    include_str!("owner_agent_proxy/provider_discovery.sh"),
    include_str!("owner_opencode_v2/discover.sh"),
    r#"
[[ $(/usr/bin/uname -s) == Linux ]] || exit 126
{ trusted_path "$cwd" && cd -P -- "$cwd" && [[ $PWD == "$cwd" ]]; } 2>/dev/null || exit 126
select_binary opencode || missing
[[ -x /usr/bin/python3 ]] || exit 126
unset PWD OLDPWD
# U19: the supervisor and OpenCode run in the captured login environment.
capture_login_env || exit 126
exec /usr/bin/env -i -- "${login_env[@]}" \
    /usr/bin/python3 -I -c "$supervisor" "$cwd" "$nonce" "$host" "$port" "$entry"
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
    /// Explicit remote executable; `None` discovers it on each target.
    binary: Option<String>,
    /// Fixture owners pin one authorized root. A production owner serves many
    /// targets, so it takes each request's own absolute remote cwd (the same
    /// rule as the production PTY); the remote guard still requires a trusted,
    /// owner- or root-owned directory before anything executes.
    root: Option<String>,
}

impl ProductRecipe {
    pub(crate) fn new(binary: Option<&Path>, root: Option<&Path>) -> io::Result<Self> {
        let binary = binary
            .map(|binary| exact_path(binary).map_err(|_| invalid_scope()))
            .transpose()?;
        let root = root
            .map(|root| exact_path(root).map_err(|_| invalid_scope()))
            .transpose()?;
        if root.is_some_and(|root| root == "/" || Some(root) == binary) {
            return Err(invalid_scope());
        }
        Ok(Self {
            binary: binary.map(str::to_owned),
            root: root.map(str::to_owned),
        })
    }

    pub(crate) fn matches(&self, scope: &ProviderServiceScope) -> bool {
        let cwd = scope.cwd.as_str();
        let cwd_allowed = match &self.root {
            Some(root) => cwd == root,
            None => {
                exact_path(Path::new(cwd)).is_ok()
                    && cwd != "/"
                    && self.binary.as_deref() != Some(cwd)
            }
        };
        cwd_allowed
            && !scope.thread_id.is_empty()
            && scope.thread_id.len() <= 128
            && scope.thread_id.bytes().all(|byte| byte.is_ascii_graphic())
    }

    pub(crate) fn run(
        &self,
        cwd: &str,
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
        let command = self.remote_command(cwd, &nonce, remote);
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

    fn remote_command(&self, cwd: &str, nonce: &str, remote: SocketAddrV4) -> String {
        format!(
            "exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\" SHELL=\"$SHELL\" USER=\"$USER\" LOGNAME=\"$LOGNAME\" LANG=\"$LANG\" PATH=/usr/bin:/bin /bin/bash -o pipefail -c {} bigbud-opencode-v2 {} {} {} {} {} {} {LIMIT}",
            quote(LAUNCH),
            // An empty operand asks the remote guard to discover the binary.
            quote(self.binary.as_deref().unwrap_or("")),
            quote(cwd),
            quote(nonce),
            remote.ip(),
            remote.port(),
            quote(include_str!("owner_opencode_v2/supervise.py")),
        )
    }
}

/// An absolute, normalized, control-free path of bounded length.
fn exact_path(path: &Path) -> io::Result<&str> {
    let path = path.to_str().ok_or_else(invalid_scope)?;
    let rest = path.strip_prefix('/').ok_or_else(invalid_scope)?;
    if path.len() > MAX_PATH_BYTES
        || path.chars().any(char::is_control)
        || rest.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(invalid_scope());
    }
    Ok(path)
}

/// Deterministic mapping from an owner-generated token to the remote port. It
/// is not a security boundary; it only keeps two live targets from choosing the
/// same remote port by accident.
fn remote_port(token: &[u8; 32]) -> u16 {
    let value = (u16::from(token[0]) << 8) | u16::from(token[1]);
    REMOTE_PORT_BASE + value % REMOTE_PORT_SPAN
}
