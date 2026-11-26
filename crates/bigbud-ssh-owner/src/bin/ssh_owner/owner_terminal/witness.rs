//! PTY readiness witnesses. A production login shell prints
//! `LOGIN_READY <pid>` from the wrapper, then `exec`s the shell, so `<pid>` is
//! the remote login shell's own PID (W2 T-term `terminal_inspect`). A U16 shell
//! that is not in the target's `/etc/shells` prints the refusal marker instead.

use super::{DEV_PROMPT, ErrorCode, LOGIN_READY, READY, TerminalLease, TerminalMode, ssh_failure};

const SHELL_REFUSED: &str = "BIGBUD_SSH_OWNER_LOGIN_PTY_SHELL_REFUSED";
const MAX_PID_DIGITS: usize = 10;

/// The wrapper fragment that selects the login shell and prints the witness.
/// `$2` is the requested U16 shell (or empty for the account's `$SHELL`); it is
/// re-checked against `/etc/shells` here, at launch, on the target itself.
pub(crate) fn login_command_witness() -> String {
    format!(
        "shell=${{SHELL:-/bin/sh}}\n\
         if [ -n \"$2\" ]; then\n\
         \x20 PATH=/usr/bin:/bin grep -qxF -- \"$2\" /etc/shells 2>/dev/null && [ -f \"$2\" ] && [ -x \"$2\" ] \
         || {{ printf '%s\\n' {SHELL_REFUSED}; exit 5; }}\n\
         \x20 shell=$2\n\
         fi\n\
         printf '%s %s\\n' {LOGIN_READY} \"$$\"\n\
         exec \"$shell\" -l\n"
    )
}

fn trimmed(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// The PID in one `LOGIN_READY <pid>` line, if this is that line.
fn witness_pid(line: &[u8]) -> Option<u32> {
    let digits = trimmed(line)
        .strip_prefix(LOGIN_READY.as_bytes())?
        .strip_prefix(b" ")?;
    if digits.is_empty() || digits.len() > MAX_PID_DIGITS || !digits.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    std::str::from_utf8(digits)
        .ok()?
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 1)
}

impl TerminalMode {
    pub(super) fn interactive(self) -> bool {
        matches!(self, Self::DevInteractive | Self::LoginShell)
    }

    pub(super) fn ready(self, sample: &[u8]) -> bool {
        sample.split(|&byte| byte == b'\n').any(|line| match self {
            Self::Proof => line
                .strip_prefix(READY)
                .is_some_and(|rest| rest.iter().all(|&byte| byte == b'\r')),
            Self::DevInteractive => {
                // macOS /bin/sh's Readline may enable xterm meta keys before PS1.
                line.strip_prefix(b"\x1b[?1034h").unwrap_or(line) == DEV_PROMPT.as_bytes()
            }
            Self::LoginShell => witness_pid(line).is_some(),
        })
    }
}

/// A PTY that exited before readiness: a typed U16 refusal, else the SSH failure.
pub(super) fn launch_failure(mode: TerminalMode, sample: &[u8]) -> ErrorCode {
    let refused = matches!(mode, TerminalMode::LoginShell)
        && sample
            .split(|&byte| byte == b'\n')
            .any(|line| trimmed(line) == SHELL_REFUSED.as_bytes());
    if refused {
        ErrorCode::TerminalShellUnavailable
    } else {
        ssh_failure(sample)
    }
}

/// The first witness PID in `sample`, from the start of the lease's output.
pub(super) fn login_shell_pid(sample: &[u8]) -> Option<u32> {
    sample.split(|&byte| byte == b'\n').find_map(witness_pid)
}

impl TerminalLease {
    /// The remote login shell's PID from the launch witness (login mode only).
    pub(crate) fn login_shell_pid(&self) -> Result<Option<u32>, ErrorCode> {
        if !matches!(self.mode, TerminalMode::LoginShell) {
            return Ok(None);
        }
        Ok(login_shell_pid(&self.snapshot()?.sample))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_witness_carries_the_exec_pid_and_nothing_else() {
        let ok = format!("motd\r\n{LOGIN_READY} 4242\r\n$ ");
        assert!(TerminalMode::LoginShell.ready(ok.as_bytes()));
        assert_eq!(login_shell_pid(ok.as_bytes()), Some(4242));
        for bad in [
            LOGIN_READY.to_owned(),
            format!("{LOGIN_READY} "),
            format!("{LOGIN_READY} 1"),
            format!("{LOGIN_READY} 12a"),
            format!("{LOGIN_READY} 12345678901"),
            format!("x{LOGIN_READY} 42"),
        ] {
            assert!(!TerminalMode::LoginShell.ready(bad.as_bytes()), "{bad:?}");
            assert_eq!(login_shell_pid(bad.as_bytes()), None, "{bad:?}");
        }
    }

    #[test]
    fn a_shell_refusal_is_typed_only_for_login_shells() {
        let refused = format!("{SHELL_REFUSED}\r\n");
        assert_eq!(
            launch_failure(TerminalMode::LoginShell, refused.as_bytes()),
            ErrorCode::TerminalShellUnavailable
        );
        assert_ne!(
            launch_failure(TerminalMode::Proof, refused.as_bytes()),
            ErrorCode::TerminalShellUnavailable
        );
    }

    #[test]
    fn the_wrapper_rechecks_etc_shells_and_prints_the_pid_witness() {
        let script = login_command_witness();
        assert!(script.contains("PATH=/usr/bin:/bin grep -qxF -- \"$2\" /etc/shells"));
        assert!(script.contains(&format!("{LOGIN_READY} \"$$\"")));
        assert!(script.ends_with("exec \"$shell\" -l\n"));
    }
}
