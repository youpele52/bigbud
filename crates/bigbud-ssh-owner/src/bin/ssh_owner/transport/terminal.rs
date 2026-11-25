use super::{DEADLINE, ErrorCode, Instant, Transport, workspace};
use crate::owner_terminal::{DEV_PROMPT, DEV_TERM, FIXTURE_COMMAND, TerminalLease, TerminalMode};

const ENTER_WORKSPACE: &str =
    "[ -d \"$target\" ] && cd -P \"$target\" && [ \"$PWD\" = \"$target\" ] || exit 3";

fn dev_shell() -> String {
    // Do not inherit SSH-provided environment or load login/ENV startup files.
    // The prompt is emitted only after the fixed interactive shell starts.
    format!(
        "[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 1\n\
         exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C \
         TERM={DEV_TERM} INPUTRC=/dev/null PS1='{DEV_PROMPT}' /bin/sh -i"
    )
}

impl Transport {
    pub(in super::super) fn probe_terminal_cwd(
        &self,
        input: crate::v1::ProofTerminalCwd,
    ) -> Result<crate::v1::ProofTerminalCwd, ErrorCode> {
        workspace::cwd::probe(self, input)
    }

    pub(in super::super) fn has_workspace_root(&self) -> bool {
        self.config.workspace_root.is_some()
    }

    pub(in super::super) fn matches_workspace_root(&self, cwd: &str) -> bool {
        self.workspace_root() == Some(cwd)
    }

    fn workspace_root(&self) -> Option<&str> {
        self.config
            .workspace_root
            .as_deref()
            .and_then(workspace::configured_root)
    }

    pub(in super::super) fn open_prepared_terminal(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalLease, ErrorCode> {
        let root = self
            .workspace_root()
            .filter(|root| *root == cwd)
            .ok_or(ErrorCode::WorkspacePathDenied)?;
        let (mode, script) = if self.config.dev_interactive_terminal {
            (
                TerminalMode::DevInteractive,
                format!("{ENTER_WORKSPACE}\n{}", dev_shell()),
            )
        } else {
            (
                TerminalMode::Proof,
                format!("{ENTER_WORKSPACE}\n{FIXTURE_COMMAND}"),
            )
        };
        let remote = workspace::workspace_command(&script, root, "");
        self.launch_terminal(&remote, (cols, rows), mode)
    }

    pub(in super::super) fn open_proof_terminal(&self) -> Result<TerminalLease, ErrorCode> {
        self.launch_terminal(FIXTURE_COMMAND, (80, 24), TerminalMode::Proof)
    }

    fn launch_terminal(
        &self,
        command: &str,
        size: (u16, u16),
        mode: TerminalMode,
    ) -> Result<TerminalLease, ErrorCode> {
        self.revalidate_policy()?;
        let deadline = Instant::now() + DEADLINE;
        let mut pinned = self.pinned_ssh("-tt")?;
        pinned
            .command
            .args(["-o", "EscapeChar=none", "--", &self.host, command]);
        TerminalLease::launch_sized(pinned, deadline, size, mode)
    }
}
