//! Startup-bound, read-only Git protocol v2 over the inherited byte streams.
//!
//! Only an empty bare SHA-1 fixture or the exact three-object fetch seed is
//! supported. No client input selects a Git command, repository, or write service.

use std::io;

const ROOT_PREFIX: &str = "/tmp/bigbud-picker-linux-";
const SCRIPT: &str = include_str!("git_upload/fixture.sh");

pub(in super::super) struct Recipe {
    repository_path: String,
    command: String,
}

impl Recipe {
    /// Both values must come from trusted startup, not the open request.
    pub(in super::super) fn new(fixture_root: &str, repository_path: &str) -> io::Result<Self> {
        let valid_root = fixture_root.strip_prefix(ROOT_PREFIX).is_some_and(|id| {
            (1..=64).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
        });
        let valid_repo = repository_path
            .strip_prefix(fixture_root)
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some_and(|name| {
                (1..=255).contains(&name.len())
                    && !matches!(name, "." | "..")
                    && !name.contains('/')
                    && !name.chars().any(char::is_control)
            });
        if !valid_root || !valid_repo {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Git upload fixture binding",
            ));
        }
        let command = format!(
            "exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C GIT_CONFIG_NOSYSTEM=1 \
             GIT_CONFIG_GLOBAL=/dev/null /bin/bash -c {} bigbud-git-upload {} {}",
            quote(SCRIPT),
            quote(fixture_root),
            quote(repository_path),
        );
        Ok(Self {
            repository_path: repository_path.to_owned(),
            command,
        })
    }

    pub(in super::super) fn matches_binding(&self, repository_path: &str) -> bool {
        self.repository_path == repository_path
    }

    pub(in super::super) fn command(&self) -> &str {
        &self.command
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
#[path = "git_upload/tests.rs"]
mod tests;
