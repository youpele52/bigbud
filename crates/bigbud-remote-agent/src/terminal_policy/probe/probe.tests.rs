use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use super::{ForegroundReason, ProbeSource, ProcessProbe, is_shell_executable, sum_tree};

/// An injectable probe: fixed process groups and executables, with optional failures.
struct FakeSource {
    foreground: io::Result<i32>,
    groups: HashMap<i32, i32>,
    executables: HashMap<i32, &'static str>,
}

impl FakeSource {
    fn new(foreground: i32) -> Self {
        Self {
            foreground: Ok(foreground),
            groups: HashMap::from([(100, 100)]),
            executables: HashMap::from([(100, "/bin/zsh")]),
        }
    }
}

impl ProbeSource for FakeSource {
    fn foreground_group(&self, _master_fd: i32) -> io::Result<i32> {
        match &self.foreground {
            Ok(group) => Ok(*group),
            Err(error) => Err(io::Error::new(error.kind(), "injected")),
        }
    }

    fn process_group(&self, pid: i32) -> io::Result<i32> {
        self.groups
            .get(&pid)
            .copied()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
    }

    fn executable(&self, pid: i32) -> io::Result<PathBuf> {
        self.executables
            .get(&pid)
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::from(io::ErrorKind::PermissionDenied))
    }
}

fn inspect(source: FakeSource) -> ForegroundReason {
    ProcessProbe::with_source(source).inspect(3, 100)
}

#[test]
fn recognizes_the_shell_set_by_file_name() {
    for shell in super::SHELL_NAMES {
        assert!(
            is_shell_executable(&Path::new("/usr/bin").join(shell)),
            "{shell}"
        );
    }
    assert!(is_shell_executable(Path::new(
        "/opt/homebrew/Cellar/bash/5.2/bin/bash"
    )));
    assert!(is_shell_executable(Path::new("/usr/bin/bash (deleted)")));
    assert!(is_shell_executable(Path::new("-zsh")));
    for program in [
        "ssh", "mosh", "tmux", "screen", "vim", "sudo", "bashful", "node",
    ] {
        assert!(
            !is_shell_executable(&Path::new("/usr/bin").join(program)),
            "{program}"
        );
    }
}

#[test]
fn the_shell_owning_the_terminal_is_not_a_program() {
    assert_eq!(
        inspect(FakeSource::new(100)),
        ForegroundReason::ShellAtPrompt
    );
}

#[test]
fn a_nested_shell_leader_is_not_a_program_but_other_leaders_are() {
    let mut source = FakeSource::new(200);
    source.executables.insert(200, "/bin/bash");
    assert_eq!(inspect(source), ForegroundReason::NestedShell);
    let mut source = FakeSource::new(200);
    source.executables.insert(200, "/usr/bin/tmux");
    assert_eq!(inspect(source), ForegroundReason::ForegroundLeader);
}

#[test]
fn a_non_shell_direct_child_is_a_program() {
    let mut source = FakeSource::new(100);
    source.executables.insert(100, "/usr/bin/htop");
    assert_eq!(inspect(source), ForegroundReason::DirectChildNotShell);
}

#[test]
fn unknown_leaders_and_probe_failures_count_as_programs() {
    // A pipeline leader that already exited, or a root-owned leader we cannot read.
    let reason = inspect(FakeSource::new(300));
    assert_eq!(reason, ForegroundReason::UnknownLeader);
    assert!(reason.is_program());
    let mut source = FakeSource::new(100);
    source.foreground = Err(io::Error::from(io::ErrorKind::Other));
    let reason = inspect(source);
    assert_eq!(reason, ForegroundReason::ProbeFailed);
    assert!(
        ProcessProbe::with_source(FakeSource {
            foreground: Err(io::Error::from(io::ErrorKind::Other)),
            ..FakeSource::new(100)
        })
        .foreground_program(3, 100)
    );
    let mut source = FakeSource::new(100);
    source.executables.clear();
    assert!(
        inspect(source).is_program(),
        "an unreadable direct child is never idle"
    );
}

#[test]
fn sums_a_process_tree_and_ignores_other_branches() {
    let table = HashMap::from([
        (1, (0, 1_000)),
        (10, (1, 100)),
        (11, (10, 10)),
        (12, (10, 20)),
        (20, (1, 5_000)),
    ]);
    assert_eq!(sum_tree(10, &table), Some(130));
    assert_eq!(sum_tree(11, &table), Some(10));
    assert_eq!(sum_tree(99, &table), None);
}

#[cfg(target_os = "linux")]
#[test]
fn parses_proc_stat_with_spaces_and_parentheses_in_the_name() {
    let stat = "42 (my (odd) name) S 7 42 42 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 1 1000 25 x";
    assert_eq!(super::linux::parse_stat(stat), Some((7, 25)));
}
