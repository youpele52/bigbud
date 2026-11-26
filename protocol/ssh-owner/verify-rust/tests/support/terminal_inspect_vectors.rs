//! W2 T-term production terminal vectors (Request 120–121, Reply 71–72), the
//! additive U16 `ProofPrepareTerminal.shell` (field 6), and the W2 T-files
//! session-FS entry verbs (Request 122–124, Reply 73–74).

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let lease = vec![0x71; 32];
    let process =
        |pid, parent_pid, group_id, foreground_group_id, command: &str| v1::TerminalProcess {
            pid,
            parent_pid,
            group_id: Some(group_id),
            foreground_group_id: Some(foreground_group_id),
            command: command.into(),
        };
    for (name, payload) in [
        (
            "terminal_inspect",
            request(Operation::TerminalInspect(v1::TerminalInspect {
                lease: lease.clone(),
            })),
        ),
        (
            "list_terminal_shells",
            request(Operation::ListTerminalShells(v1::Empty {})),
        ),
        (
            "proof_terminal_prepare_shell",
            request(Operation::PrepareTerminal(v1::ProofPrepareTerminal {
                cwd: "/srv/work".into(),
                thread_id: "thread".into(),
                terminal_id: "pane".into(),
                cols: 96,
                rows: 34,
                shell: Some("/usr/bin/zsh".into()),
            })),
        ),
        (
            "terminal_processes",
            reply(Outcome::TerminalProcesses(v1::TerminalProcesses {
                lease: lease.clone(),
                shell_pid: 4242,
                processes: vec![
                    process(4242, 4200, 4242, 4300, "-zsh"),
                    process(4300, 4242, 4300, 4300, "vim notes.txt"),
                ],
                truncated: false,
            })),
        ),
        (
            "terminal_processes_truncated",
            reply(Outcome::TerminalProcesses(v1::TerminalProcesses {
                lease: lease.clone(),
                shell_pid: 4242,
                processes: Vec::new(),
                truncated: true,
            })),
        ),
        (
            "terminal_shells",
            reply(Outcome::TerminalShells(v1::TerminalShells {
                paths: vec!["/bin/bash".into(), "/usr/bin/zsh".into()],
            })),
        ),
        // W2 T-files session-FS entry verbs (Request 122–124, Reply 73–74).
        (
            "workspace_entry_info",
            request(Operation::WorkspaceEntryInfo(
                v1::WorkspaceEntryInfoRequest {
                    workspace_root: "/srv/work".into(),
                    relative_path: "src/main.rs".into(),
                },
            )),
        ),
        (
            "workspace_rename",
            request(Operation::WorkspaceRename(v1::WorkspaceRenameRequest {
                workspace_root: "/srv/work".into(),
                relative_path: "a.txt".into(),
                destination_path: "b/a.txt".into(),
                replace: false,
            })),
        ),
        (
            "workspace_rename_replace",
            request(Operation::WorkspaceRename(v1::WorkspaceRenameRequest {
                workspace_root: "/srv/work".into(),
                relative_path: "a.tmp".into(),
                destination_path: "a.txt".into(),
                replace: true,
            })),
        ),
        (
            "workspace_append",
            request(Operation::WorkspaceAppend(v1::WorkspaceAppendRequest {
                workspace_root: "/srv/work".into(),
                relative_path: "log.txt".into(),
                contents: b"line\n".to_vec(),
            })),
        ),
        (
            "workspace_entry_info_reply",
            reply(Outcome::WorkspaceEntryInfo(v1::WorkspaceEntryInfo {
                kind: 2,
                size: 42,
                mtime_ms: 1_764_000_000_000,
                birthtime_ms: 1_763_000_000_000,
            })),
        ),
        (
            "workspace_entry_change",
            reply(Outcome::WorkspaceEntryChange(v1::WorkspaceEntryChange {
                result: 1,
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
