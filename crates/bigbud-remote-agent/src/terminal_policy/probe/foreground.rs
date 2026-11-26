//! The `foreground_program` fact (plan §8.5, N9, F6).
//!
//! A PTY runs a foreground program when its direct child is not a shell, or when the
//! terminal's foreground process group is not the shell's and that group's leader is not a
//! shell either. Nested shells at their prompt are therefore idle, while a program started in
//! a nested shell becomes the foreground leader and is detected. An unknown or unreadable
//! leader (an exited pipeline leader, a root-owned `sudo vim`, a probe failure) counts as a
//! program: the rule never errs toward idle. `ssh`, `mosh`, `tmux` and `screen` are programs.

use std::io;
use std::path::{Path, PathBuf};

/// Executables that count as a shell prompt rather than a program.
pub const SHELL_NAMES: [&str; 11] = [
    "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "xonsh",
];

/// True when the executable's file name is in [`SHELL_NAMES`]. Login-shell dashes and the
/// Linux ` (deleted)` suffix of a replaced binary are ignored.
pub fn is_shell_executable(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let name = name.strip_suffix(" (deleted)").unwrap_or(name);
    let name = name.strip_prefix('-').unwrap_or(name);
    SHELL_NAMES.contains(&name)
}

/// The OS facts the rule needs; tests inject failures through this seam.
pub trait ProbeSource {
    /// `tcgetpgrp(master_fd)`.
    fn foreground_group(&self, master_fd: i32) -> io::Result<i32>;
    /// `getpgid(pid)`.
    fn process_group(&self, pid: i32) -> io::Result<i32>;
    /// `/proc/<pid>/exe` on Linux, `proc_pidpath` on macOS.
    fn executable(&self, pid: i32) -> io::Result<PathBuf>;
}

/// The real OS probe.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemProbe;

impl ProbeSource for SystemProbe {
    fn foreground_group(&self, master_fd: i32) -> io::Result<i32> {
        super::sys::foreground_group(master_fd)
    }

    fn process_group(&self, pid: i32) -> io::Result<i32> {
        super::sys::process_group(pid)
    }

    fn executable(&self, pid: i32) -> io::Result<PathBuf> {
        super::sys::executable(pid)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForegroundReason {
    /// The shell (direct child) owns the terminal.
    ShellAtPrompt,
    /// Another shell (`bash`, `su -`, `nix-shell`) owns the terminal at its prompt.
    NestedShell,
    /// The PTY's direct child is not a shell (a TUI launched directly, or `exec`'d).
    DirectChildNotShell,
    /// A non-shell foreground group leader.
    ForegroundLeader,
    /// The foreground leader's executable could not be read.
    UnknownLeader,
    /// The terminal or process-group query failed.
    ProbeFailed,
}

impl ForegroundReason {
    pub fn is_program(self) -> bool {
        !matches!(self, Self::ShellAtPrompt | Self::NestedShell)
    }
}

/// Probes PTY foreground state and process-tree memory.
#[derive(Debug, Clone, Default)]
pub struct ProcessProbe<S = SystemProbe> {
    source: S,
}

impl ProcessProbe<SystemProbe> {
    pub fn new() -> Self {
        Self {
            source: SystemProbe,
        }
    }
}

impl<S: ProbeSource> ProcessProbe<S> {
    pub fn with_source(source: S) -> Self {
        Self { source }
    }

    /// Checked every 2 s and on foreground-group changes by the host loop.
    pub fn foreground_program(&self, master_fd: i32, child_pid: i32) -> bool {
        self.inspect(master_fd, child_pid).is_program()
    }

    pub fn inspect(&self, master_fd: i32, child_pid: i32) -> ForegroundReason {
        match self.source.executable(child_pid) {
            Ok(path) if is_shell_executable(&path) => {}
            Ok(_) => return ForegroundReason::DirectChildNotShell,
            Err(_) => return ForegroundReason::UnknownLeader,
        }
        let (Ok(foreground), Ok(shell_group)) = (
            self.source.foreground_group(master_fd),
            self.source.process_group(child_pid),
        ) else {
            return ForegroundReason::ProbeFailed;
        };
        if foreground <= 0 {
            return ForegroundReason::ProbeFailed;
        }
        if foreground == shell_group {
            return ForegroundReason::ShellAtPrompt;
        }
        match self.source.executable(foreground) {
            Ok(path) if is_shell_executable(&path) => ForegroundReason::NestedShell,
            Ok(_) => ForegroundReason::ForegroundLeader,
            Err(_) => ForegroundReason::UnknownLeader,
        }
    }

    /// Resident bytes of `root_pid` and all its descendants (every 30 s for managed PTYs).
    pub fn tree_rss(&self, root_pid: i32) -> Option<u64> {
        self.tree_rss_many(&[root_pid]).into_iter().next().flatten()
    }

    /// One process-table pass for several roots; `None` for a root that is gone.
    pub fn tree_rss_many(&self, roots: &[i32]) -> Vec<Option<u64>> {
        super::sys::tree_rss(roots)
    }
}
