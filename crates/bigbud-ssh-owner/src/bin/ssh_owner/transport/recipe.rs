//! Bounded execution of owner-compiled remote recipes.
//!
//! The owner, not the wire client, selects the program, arguments, working
//! directory and environment. Callers pass one fixed script plus already
//! validated positional data (artifact identity), so a request can never
//! introduce a command, flag, path or environment value.

use super::{
    ErrorCode, Transport,
    process::{self, Failure},
    workspace,
};
use std::time::Duration;

/// Exit and bounded output of one fixed recipe.
pub(crate) struct RecipeOutput {
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) truncated: bool,
}

impl Transport {
    /// Run one fixed `/bin/sh` recipe over the pinned direct route.
    ///
    /// `Failure` is flattened to the shared codes: a timeout becomes
    /// `ShellTimedOut`, a missing image `OwnerUnavailable`, and any other I/O
    /// loss `TransportLost`. Callers that mutate remote state treat the last two
    /// as ambiguous rather than retrying.
    pub(crate) fn run_owner_recipe(
        &self,
        script: &str,
        args: &[&str],
        timeout: Duration,
        limit: usize,
        input: Option<&[u8]>,
    ) -> Result<RecipeOutput, ErrorCode> {
        self.revalidate_policy()?;
        let remote = recipe_command(script, args);
        let (pinned, deadline) = workspace::pinned_workspace_command(self, &remote, timeout)?;
        let result = match input {
            Some(bytes) => process::run_with_input(pinned.command, deadline, limit, bytes),
            None => process::run(pinned.command, deadline, limit),
        };
        result
            .map(|output| RecipeOutput {
                code: output.status.code(),
                stdout: output.stdout,
                stderr: output.stderr,
                truncated: output.truncated,
            })
            .map_err(|failure| match failure {
                Failure::TimedOut => ErrorCode::ShellTimedOut,
                Failure::Spawn => ErrorCode::OwnerUnavailable,
                Failure::Io => ErrorCode::TransportLost,
            })
    }
}

/// `$0` is the fixed `sh` label; every positional argument is quoted data.
fn recipe_command(script: &str, args: &[&str]) -> String {
    let mut command = format!("/bin/sh -c {} sh", workspace::quote(script));
    for arg in args {
        command.push(' ');
        command.push_str(&workspace::quote(arg));
    }
    command
}
