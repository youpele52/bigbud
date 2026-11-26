#![allow(dead_code)] // Linux-only product path; grant logic is unit-tested on every host.

//! Product provider service recipes, selected by the trusted launcher.
//!
//! The configured remote executable and the fixed argument recipe live here; a
//! request contributes only the authorized session. Every operand reaches the
//! remote shell through `quote`, and the guard validates directories, file
//! identity and ELF identity before executing the opened descriptor. Unlike the
//! proof recipe, the content digest cannot be pinned ahead of configuration, so
//! the trusted SSH account remains the identity authority (the same account the
//! proof instructions already trust).

use super::MAX_BINARY_BYTES;
use super::v1::ProofProviderScope;
use std::{io, path::Path};

const MAX_PATH_BYTES: usize = 4095;
const LIMIT: u64 = MAX_BINARY_BYTES;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Kind {
    Codex,
    Pi,
}

pub(in crate::owner_agent_proxy) struct Recipe {
    kind: Kind,
    binary: String,
    root: String,
}

impl Recipe {
    pub(in crate::owner_agent_proxy) fn new(
        kind: Kind,
        binary: &Path,
        root: &Path,
    ) -> io::Result<Self> {
        let binary = exact_path(binary)?;
        let root = exact_path(root)?;
        if root == "/" || binary == root {
            return Err(invalid_binding());
        }
        Ok(Self {
            kind,
            binary: binary.to_owned(),
            root: root.to_owned(),
        })
    }

    pub(in crate::owner_agent_proxy) fn kind(&self) -> Kind {
        self.kind
    }

    /// The configured executable and fixed workspace must match exactly. A Pi
    /// resume path is validated as a bounded path inside that workspace.
    pub(in crate::owner_agent_proxy) fn matches(&self, scope: &ProofProviderScope) -> bool {
        scope.binary == self.binary
            && scope.cwd == self.root
            && !scope.thread_id.is_empty()
            && scope.thread_id.len() <= 128
            && scope.thread_id.bytes().all(|byte| byte.is_ascii_graphic())
            && match (self.kind, scope.session_file.as_deref()) {
                (Kind::Codex, None) => true,
                (Kind::Pi, Some(file)) => session_file_in_workspace(file, &self.root),
                (Kind::Pi, None) => true,
                _ => false,
            }
    }

    pub(in crate::owner_agent_proxy) fn probe_command(&self) -> String {
        self.compile("probe", None)
    }

    pub(in crate::owner_agent_proxy) fn command(&self, scope: &ProofProviderScope) -> String {
        let resume = match self.kind {
            Kind::Pi => scope.session_file.as_deref(),
            Kind::Codex => None,
        };
        self.compile("start", resume)
    }

    fn compile(&self, action: &str, resume: Option<&str>) -> String {
        let script = match self.kind {
            Kind::Codex => CODEX_SCRIPT,
            Kind::Pi => PI_SCRIPT,
        };
        let mut operands = format!(
            "{} {} {LIMIT} {action}",
            quote(&self.binary),
            quote(&self.root)
        );
        if self.kind == Kind::Pi {
            operands.push(' ');
            operands.push_str(&quote(resume.unwrap_or("")));
            operands.push(' ');
            operands.push_str(if resume.is_some() { "1" } else { "0" });
        }
        // `$HOME` is expanded by the remote login shell, so the provider keeps
        // the account's real credentials; the inner environment stays fixed.
        format!(
            "exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\" PATH=/usr/bin:/bin \
             /bin/bash -o pipefail -c {} bigbud-provider-service {operands}",
            quote(script)
        )
    }
}

/// Lexical scope plus no symlink escape for an existing Pi session file.
fn session_file_in_workspace(file: &str, root: &str) -> bool {
    file.len() > root.len()
        && file.len() <= MAX_PATH_BYTES
        && !file.chars().any(char::is_control)
        && file.starts_with(&format!("{root}/"))
        && file
            .strip_prefix(&format!("{root}/"))
            .is_some_and(|rest| !rest.split('/').any(|part| matches!(part, "" | "." | "..")))
}

fn invalid_binding() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid provider service binding",
    )
}

fn exact_path(path: &Path) -> io::Result<&str> {
    let path = path.to_str().ok_or_else(invalid_binding)?;
    let rest = path.strip_prefix('/').ok_or_else(invalid_binding)?;
    if path.len() > MAX_PATH_BYTES
        || path.chars().any(char::is_control)
        || rest.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(invalid_binding());
    }
    Ok(path)
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// The guard shares the proof checks for directories and the opened ELF, but it
// accepts a configured absolute executable and cannot compare a content digest.
const PI_SCRIPT: &str = concat!(
    r#"
[[ $# == 6 ]] || exit 126
binary=$1 cwd=$2 limit=$3 action=$4 resume=$5 has_resume=$6
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'

"#,
    include_str!("provider_service_guard.sh"),
    r#"
validate 2>/dev/null || exit 126
if [[ $has_resume == 1 ]]; then
    [[ $resume == "$cwd"/* && -f $resume && ! -L $resume ]] || exit 126
    dir=$(cd -P -- "${resume%/*}" 2>/dev/null && pwd) || exit 126
    [[ $dir/${resume##*/} == $resume ]] || exit 126
fi
unset PWD OLDPWD
case "$action" in
    probe) exec "$fd" --version ;;
    start)
        if [[ $has_resume == 1 ]]; then exec "$fd" --mode rpc --session "$resume"; fi
        exec "$fd" --mode rpc ;;
    *) exit 126 ;;
esac
"#
);

const CODEX_SCRIPT: &str = concat!(
    r#"
[[ $# == 4 ]] || exit 126
binary=$1 cwd=$2 limit=$3 action=$4
fd=/proc/self/fd/9
fields='%d:%i:%f:%u:%h:%s:%y:%z'

"#,
    include_str!("provider_service_guard.sh"),
    r#"
validate 2>/dev/null || exit 126
unset PWD OLDPWD
case "$action" in
    probe) exec "$fd" --version ;;
    start) exec "$fd" app-server ;;
    *) exit 126 ;;
esac
"#
);

#[cfg(test)]
#[path = "provider_service/tests.rs"]
mod tests;
