//! W2 T-term `terminal_inspect` (Request 120 / Reply 71) and the U16 shell
//! inventory (Request 121 / Reply 72).
//!
//! Both run one fixed, owner-chosen command as a mux session over the exact
//! target's verified production master: no second SSH connection, no PTY, no
//! caller-supplied argv. Output and time are bounded, and inspection returns
//! only the exact lease's login shell and its descendants.

use super::{ErrorCode, Owner};
use crate::{
    transport::posix_master::{AgentIo, read_exit},
    v1::{TerminalInspect, TerminalProcess, TerminalProcesses, TerminalShells},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const DEADLINE: Duration = Duration::from_secs(5);
const PS: &str = "PATH=/usr/bin:/bin LC_ALL=C exec ps -e -ww -o pid=,ppid=,pgid=,tpgid=,command=";
// Only absolute lines naming an existing executable regular file.
const SHELLS: &str = "PATH=/usr/bin:/bin LC_ALL=C; while IFS= read -r line; do \
case \"$line\" in /*) [ -f \"$line\" ] && [ -x \"$line\" ] && printf '%s\\n' \"$line\";; esac; \
done < /etc/shells";
const PS_LIMIT: usize = 512 * 1024;
const SHELLS_LIMIT: usize = 16 * 1024;
const MAX_PROCESSES: usize = 512;
const MAX_COMMAND_BYTES: usize = 1024;
const MAX_SHELLS: usize = 64;
const MAX_SHELL_BYTES: usize = 256;

/// A U16 shell operand: an absolute, normalized path of plain path bytes.
pub(super) fn valid_shell_path(path: &str) -> bool {
    path.len() <= MAX_SHELL_BYTES
        && path.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-' | b'+')
        })
        && path.strip_prefix('/').is_some_and(|rest| {
            !rest.is_empty() && rest.split('/').all(|part| !matches!(part, "" | "." | ".."))
        })
}

impl Owner {
    pub(in super::super) fn inspect_terminal(
        &mut self,
        request: &TerminalInspect,
    ) -> Result<TerminalProcesses, ErrorCode> {
        if !self.production {
            return Err(ErrorCode::OperationDenied);
        }
        // A lease without a launch witness cannot name its shell; report that
        // as unknown rather than guessing from the process table.
        let shell_pid = self
            .live_terminal(&request.lease)?
            .shell_pid
            .ok_or(ErrorCode::OutcomeUnknown)?;
        let output = self.run_on_master(PS, PS_LIMIT)?;
        let (processes, truncated) = shell_tree(&output, shell_pid);
        Ok(TerminalProcesses {
            lease: request.lease.clone(),
            shell_pid,
            processes,
            truncated,
        })
    }

    pub(in super::super) fn list_terminal_shells(&mut self) -> Result<TerminalShells, ErrorCode> {
        if !self.production {
            return Err(ErrorCode::OperationDenied);
        }
        let output = self.run_on_master(SHELLS, SHELLS_LIMIT)?;
        Ok(TerminalShells {
            paths: shell_paths(&output),
        })
    }

    pub(super) fn run_on_master(
        &mut self,
        command: &str,
        limit: usize,
    ) -> Result<Vec<u8>, ErrorCode> {
        let transport = super::super::present(&self.transport)?;
        let generation = self.generation;
        let picker = self
            .lanes
            .master
            .as_mut()
            .ok_or(ErrorCode::OwnerUnavailable)?;
        let (_master, io) = picker.open_production_agent_session(transport, generation, command)?;
        collect(io, Instant::now() + DEADLINE, limit)
    }
}

/// Read stdout to EOF within `limit` and the deadline, then require exit 0.
/// Dropping the control stream on any failure ends only this mux session.
fn collect(io: AgentIo, deadline: Instant, limit: usize) -> Result<Vec<u8>, ErrorCode> {
    let AgentIo {
        mut control,
        session,
        input,
        mut output,
        stderr,
    } = io;
    drop(input);
    drop(stderr);
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("ssh-owner-term-inspect".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let read = (&mut output)
                .take(u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1))
                .read_to_end(&mut bytes)
                .map(|_| bytes);
            // The receiver may already have timed out; nothing waits for this.
            let _sent = sender.send(read);
        })
        .map_err(|_| ErrorCode::OwnerUnavailable)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let bytes = match receiver.recv_timeout(remaining) {
        Ok(Ok(bytes)) if bytes.len() <= limit => bytes,
        Ok(Ok(_)) => return Err(ErrorCode::WorkspaceReadFailed),
        Ok(Err(_)) => return Err(ErrorCode::TransportLost),
        Err(_) => return Err(ErrorCode::TransportLost),
    };
    control
        .set_nonblocking(true)
        .map_err(|_| ErrorCode::TransportLost)?;
    let mut packet = [0; 16];
    let mut used = 0;
    loop {
        if let Some(exit) = read_exit(&mut control, &mut packet, &mut used, session)? {
            return if exit.code == Some(0) {
                Ok(bytes)
            } else {
                Err(ErrorCode::WorkspaceReadFailed)
            };
        }
        if Instant::now() >= deadline {
            return Err(ErrorCode::TransportLost);
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn number(field: &str) -> Option<i64> {
    field.parse::<i64>().ok()
}

/// One `ps` line: pid, ppid, pgid, tpgid, then the command (may contain spaces).
fn parse_line(line: &str) -> Option<TerminalProcess> {
    let mut rest = line.trim_start();
    let mut fields = [0_i64; 4];
    for field in &mut fields {
        let end = rest.find(char::is_whitespace)?;
        *field = number(rest.get(..end)?)?;
        rest = rest.get(end..)?.trim_start();
    }
    let [pid, ppid, pgid, tpgid] = fields;
    let group = |value: i64| u32::try_from(value).ok().filter(|value| *value > 0);
    let mut command = rest.trim_end().to_owned();
    if command.len() > MAX_COMMAND_BYTES {
        let mut end = MAX_COMMAND_BYTES;
        while !command.is_char_boundary(end) {
            end -= 1;
        }
        command.truncate(end);
    }
    Some(TerminalProcess {
        pid: u32::try_from(pid).ok().filter(|pid| *pid > 0)?,
        parent_pid: u32::try_from(ppid).ok()?,
        group_id: group(pgid),
        foreground_group_id: group(tpgid),
        command,
    })
}

/// The shell itself plus every descendant, in PID order, bounded.
fn shell_tree(output: &[u8], shell_pid: u32) -> (Vec<TerminalProcess>, bool) {
    let text = String::from_utf8_lossy(output);
    let all: BTreeMap<u32, TerminalProcess> = text
        .lines()
        .filter_map(parse_line)
        .map(|process| (process.pid, process))
        .collect();
    let mut keep = BTreeSet::new();
    if all.contains_key(&shell_pid) {
        keep.insert(shell_pid);
        // Parents precede children only by tree depth, so iterate to a fixpoint.
        loop {
            let before = keep.len();
            for process in all.values() {
                if keep.contains(&process.parent_pid) {
                    keep.insert(process.pid);
                }
            }
            if keep.len() == before {
                break;
            }
        }
    }
    let truncated = keep.len() > MAX_PROCESSES;
    // The shell first, then its descendants in PID order.
    let processes = keep
        .contains(&shell_pid)
        .then_some(shell_pid)
        .into_iter()
        .chain(keep.iter().copied().filter(|pid| *pid != shell_pid))
        .take(MAX_PROCESSES)
        .filter_map(|pid| all.get(&pid).cloned())
        .collect();
    (processes, truncated)
}

fn shell_paths(output: &[u8]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    String::from_utf8_lossy(output)
        .lines()
        .filter(|line| valid_shell_path(line))
        .filter(|line| seen.insert((*line).to_owned()))
        .take(MAX_SHELLS)
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
#[path = "terminal_inspect.tests.rs"]
mod tests;
