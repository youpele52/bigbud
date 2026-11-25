//! Isolated Linux OpenCode v1 proof. Only this recipe has SSH forwarding authority.

#[path = "owner_opencode_v1/product.rs"]
mod product;
pub(super) use product::{ProductRecipe, exact_path};
#[cfg(test)]
#[path = "owner_opencode_v1/tests.rs"]
mod tests;

pub(super) use crate::owner_opencode::Outcome;

use super::{random_token, transport::PinnedSsh, v1::ProofProviderScope};
#[cfg(test)]
use crate::owner_opencode::{Control, ForwardSocket, Receipt, settle};
use crate::owner_opencode::{ReadyPort, hex, quote, run as run_session, unavailable};
use bigbud_ssh_owner::opencode_v1::{REMOTE_ENDPOINT, Startup};
use std::io;

const FIXTURE_PREFIX: &str = "/tmp/bigbud-opencode-v1-";
const LIMIT: u64 = 128 * 1024 * 1024;
const RECEIPT_TAG: &str = "bigbud-opencode-v1";
const REAP_WORKER: &str = "proof-opencode-v1-reap";

const LAUNCH: &str = concat!(
    r#"
[[ $# == 9 ]] || exit 126
binary=$1 expected=$2 cwd=$3 root=$4 limit=$5 nonce=$6 host=$7 port=$8 supervisor=$9
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'
safe_home() { private_dir "$root"; }
"#,
    include_str!("owner_agent_proxy/provider_elf_guard.sh"),
    r#"
validate 2>/dev/null || exit 126
[[ -x /usr/bin/python3 ]] || exit 126
umask 077
exec /usr/bin/python3 -I -c "$supervisor" "$root" "$nonce" "$host" "$port"
"#,
);

#[derive(Clone)]
pub(super) struct Recipe {
    scope: ProofProviderScope,
    command: String,
}

impl Recipe {
    pub(super) fn new(scope: ProofProviderScope, sha256: String) -> io::Result<Self> {
        let binary_root = fixture_root(&scope.binary).ok_or_else(invalid_scope)?;
        let cwd_root = fixture_root(&scope.cwd).ok_or_else(invalid_scope)?;
        if binary_root != cwd_root
            || scope.binary == scope.cwd
            || sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            || scope.thread_id.is_empty()
            || scope.thread_id.len() > 128
            || !scope.thread_id.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(invalid_scope());
        }
        let command = format!(
            "exec /usr/bin/env -i LC_ALL=C /bin/bash -o pipefail -c {} bigbud-opencode-v1 {} {} {} {} {LIMIT}",
            quote(LAUNCH),
            quote(&scope.binary),
            quote(&sha256),
            quote(&scope.cwd),
            quote(cwd_root),
        );
        Ok(Self { scope, command })
    }

    pub(super) fn matches(&self, scope: &ProofProviderScope) -> bool {
        self.scope == *scope
    }

    pub(super) fn run(
        &self,
        pinned: PinnedSsh,
        host: &str,
        publish: impl FnOnce(ReadyPort) -> bool,
        cancelled: impl Fn() -> bool,
    ) -> Outcome {
        let Ok(mut startup) = Startup::reserve() else {
            return unavailable();
        };
        let Ok(nonce) = random_token() else {
            return unavailable();
        };
        let nonce = hex(&nonce);
        let command = self.remote_command(&nonce);
        let outcome = run_session(
            pinned,
            host,
            &command,
            REMOTE_ENDPOINT,
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

    fn remote_command(&self, nonce: &str) -> String {
        format!(
            "{} {} {} {} {}",
            self.command,
            quote(nonce),
            REMOTE_ENDPOINT.ip(),
            REMOTE_ENDPOINT.port(),
            quote(include_str!("owner_opencode_v1/supervise.py"))
        )
    }
}

fn fixture_root(path: &str) -> Option<&str> {
    let rest = path.strip_prefix(FIXTURE_PREFIX)?;
    let (name, trailing) = rest.split_once('/')?;
    if path.len() > 4095
        || path.chars().any(char::is_control)
        || name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|byte| byte.is_ascii_alphanumeric())
        || trailing
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
    {
        return None;
    }
    path.get(..FIXTURE_PREFIX.len() + name.len())
}

fn invalid_scope() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid OpenCode v1 proof binding",
    )
}
