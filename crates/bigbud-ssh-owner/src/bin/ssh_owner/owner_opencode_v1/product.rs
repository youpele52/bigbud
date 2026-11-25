//! Owner-selected OpenCode v1 listener for a configured remote executable.
//!
//! This is the only product provider with forwarding authority. The listener and
//! the single `-L` come from the owner (`Startup::reserve`, a private socket and
//! a constant loopback endpoint); the request contributes only the authorized
//! workspace.

use super::{LAUNCH, LIMIT, REAP_WORKER, RECEIPT_TAG};
use super::{invalid_scope, quote};
use crate::owner_opencode::{Outcome, ReadyPort, hex, run as run_session, unavailable};
use crate::transport::PinnedSsh;
use crate::v1::ProviderServiceScope;
use bigbud_ssh_owner::opencode_v1::{REMOTE_ENDPOINT, Startup};
use std::io;
use std::path::Path;

const MAX_PATH_BYTES: usize = 4095;

#[derive(Debug)]
pub(crate) struct ProductRecipe {
    binary: String,
    root: String,
}

impl ProductRecipe {
    pub(crate) fn new(binary: &Path, root: &Path) -> io::Result<Self> {
        let binary = exact_path(binary)?;
        let root = exact_path(root)?;
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
        let Ok(mut startup) = Startup::reserve() else {
            return unavailable();
        };
        let Ok(nonce) = crate::random_token() else {
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
            "exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\" PATH=/usr/bin:/bin /bin/bash -o pipefail -c {} bigbud-opencode-service {} {} {LIMIT} {} {} {} {} product",
            quote(LAUNCH),
            quote(&self.binary),
            quote(&self.root),
            quote(nonce),
            REMOTE_ENDPOINT.ip(),
            REMOTE_ENDPOINT.port(),
            quote(include_str!("../owner_opencode_v1/supervise.py")),
        )
    }
}

pub(crate) fn exact_path(path: &Path) -> io::Result<&str> {
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
