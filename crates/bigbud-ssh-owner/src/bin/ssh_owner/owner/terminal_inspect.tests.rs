use super::*;

const PS_OUTPUT: &str = "    1     0     1    -1 /sbin/init\n\
  100     1   100    -1 sshd: dev [priv]\n\
  200   100   200   300 -bash\n\
  300   200   300   300 vim notes.txt\n\
  301   300   300   300 /usr/bin/python3 -c print('a b')\n\
  400     1   400    -1 unrelated daemon\n\
  500   400   500    -1 child of unrelated\n\
garbage line\n";

#[test]
fn returns_only_the_shell_and_its_descendants() {
    let (processes, truncated) = shell_tree(PS_OUTPUT.as_bytes(), 200);
    assert!(!truncated);
    let pids: Vec<_> = processes.iter().map(|process| process.pid).collect();
    assert_eq!(pids, [200, 300, 301]);
    let shell = &processes[0];
    assert_eq!(shell.parent_pid, 100);
    assert_eq!(shell.group_id, Some(200));
    assert_eq!(shell.foreground_group_id, Some(300));
    assert_eq!(shell.command, "-bash");
    assert_eq!(processes[2].command, "/usr/bin/python3 -c print('a b')");
}

#[test]
fn the_shell_comes_first_even_when_a_child_has_a_lower_pid() {
    let output = "900 1 900 50 -zsh\n50 900 50 50 top\n";
    let pids: Vec<_> = shell_tree(output.as_bytes(), 900)
        .0
        .iter()
        .map(|process| process.pid)
        .collect();
    assert_eq!(pids, [900, 50]);
}

#[test]
fn an_absent_shell_yields_no_processes_and_no_tty_has_no_foreground_group() {
    assert!(shell_tree(PS_OUTPUT.as_bytes(), 999).0.is_empty());
    let (daemon, _) = shell_tree(PS_OUTPUT.as_bytes(), 400);
    assert_eq!(daemon[0].foreground_group_id, None);
    assert_eq!(daemon.len(), 2);
}

#[test]
fn bounds_the_tree_and_each_command() {
    let mut output = String::from("10 1 10 10 sh\n");
    for pid in 11..(11 + MAX_PROCESSES as u32 + 5) {
        output.push_str(&format!(
            "{pid} 10 10 10 {}\n",
            "x".repeat(2 * MAX_COMMAND_BYTES)
        ));
    }
    let (processes, truncated) = shell_tree(output.as_bytes(), 10);
    assert!(truncated);
    assert_eq!(processes.len(), MAX_PROCESSES);
    assert!(
        processes
            .iter()
            .all(|process| process.command.len() <= MAX_COMMAND_BYTES)
    );
}

#[test]
fn shell_paths_are_absolute_normalized_unique_and_bounded() {
    let output = "/bin/bash\n/usr/bin/zsh\n/bin/bash\nrelative\n/usr/../bin/sh\n/bin/a b\n/usr/local/bin/fish\n";
    assert_eq!(
        shell_paths(output.as_bytes()),
        ["/bin/bash", "/usr/bin/zsh", "/usr/local/bin/fish"]
    );
    for bad in [
        "/",
        "bin/sh",
        "/bin//sh",
        "/bin/./sh",
        "/bin/sh;rm",
        "/bin/$SHELL",
    ] {
        assert!(!valid_shell_path(bad), "{bad}");
    }
    assert!(valid_shell_path("/opt/homebrew/bin/nu"));
}

mod production {
    use super::super::super::production_tests::support::Fixture;
    use crate::v1::{ErrorCode, ProofPrepareTerminal, TerminalInspect};

    fn request(cwd: &str) -> ProofPrepareTerminal {
        ProofPrepareTerminal {
            cwd: cwd.into(),
            thread_id: "thread".into(),
            terminal_id: "terminal".into(),
            cols: 80,
            rows: 24,
            shell: None,
        }
    }

    #[test]
    fn admission_dispatch_and_shell_operands() {
        let fixture = Fixture::new();
        let mut owner = fixture.owner(None);
        fixture.bind(&mut owner, "ssh:production-a", 22222);
        // A U16 shell must be an absolute, normalized plain path.
        for shell in ["bash", "/bin/../sh", "/bin/sh;id", "/"] {
            let prepare = ProofPrepareTerminal {
                shell: Some(shell.into()),
                ..request("/home/tester/work")
            };
            assert_eq!(
                owner.prepare_terminal(prepare).err(),
                Some(ErrorCode::InvalidOperands),
                "{shell}"
            );
        }
        let prepare = ProofPrepareTerminal {
            shell: Some("/usr/bin/zsh".into()),
            ..request("/home/tester/work")
        };
        assert!(owner.prepare_terminal(prepare).is_ok());
        // Inspection names only a live lease of this exact target.
        assert_eq!(
            owner
                .inspect_terminal(&TerminalInspect { lease: vec![9; 32] })
                .err(),
            Some(ErrorCode::OperationDenied)
        );
    }
}
