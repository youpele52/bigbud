//! Real-PTY tests for the §8.5 busy rule (R3). Each spawns an interactive bash with job control.
#![cfg(unix)]

use std::process::{Command, Stdio};

use super::pty_fixture::{TestPty, which};
use super::{ForegroundReason, ProcessProbe};
use crate::terminal_policy::clock::Clock;
use crate::terminal_policy::{ActivityTracker, FakeClock, IdleEvent, IdleTimings};

const MINUTE: u64 = 60_000;

fn bash_or_skip() -> Option<TestPty> {
    let pty = TestPty::bash();
    if pty.is_none() {
        eprintln!("skipping: bash is not installed");
    }
    pty
}

fn reason(pty: &TestPty) -> ForegroundReason {
    ProcessProbe::new().inspect(pty.fd(), pty.pid)
}

fn settles_to(pty: &mut TestPty, expected: ForegroundReason) {
    let settled = pty.wait_for(|pty| reason(pty) == expected);
    assert!(
        settled,
        "expected {expected:?}, got {:?}; output {:?}",
        reason(pty),
        pty.text()
    );
}

/// Output at the fake `t0`, nothing else: warning at t0+9 and close at t0+10 minutes.
fn assert_idle_closes_after_ten_minutes(foreground: bool) {
    let clock = FakeClock::new(1_000_000);
    let mut tracker = ActivityTracker::new(true, clock.now_ms() - MINUTE);
    tracker.record_output(clock.now_ms());
    tracker.set_foreground_program(foreground, clock.now_ms());
    let t0 = clock.now_ms();
    clock.set(t0 + 9 * MINUTE);
    let warning = tracker.evaluate_idle(clock.now_ms(), IdleTimings::default());
    assert_eq!(
        warning,
        Some(IdleEvent::Warning {
            closes_at: t0 + 10 * MINUTE
        })
    );
    clock.set(t0 + 10 * MINUTE);
    assert_eq!(
        tracker.evaluate_idle(clock.now_ms(), IdleTimings::default()),
        Some(IdleEvent::Close)
    );
    assert!(tracker.still_idle(clock.now_ms()));
}

#[test]
fn a_bare_prompt_is_not_busy() {
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    settles_to(&mut pty, ForegroundReason::ShellAtPrompt);
    assert!(!ProcessProbe::new().foreground_program(pty.fd(), pty.pid));
}

#[test]
fn a_silent_prompt_helper_is_not_busy_and_goes_idle() {
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    // Like p10k's gitstatusd: a detached, silent helper started by the shell.
    pty.send("(sleep 120 >/dev/null 2>&1 &)");
    assert!(pty.read_until("READY$ "));
    settles_to(&mut pty, ForegroundReason::ShellAtPrompt);
    assert_idle_closes_after_ten_minutes(false);
}

#[test]
fn exec_of_a_non_shell_is_busy() {
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    pty.send("exec sleep 120");
    settles_to(&mut pty, ForegroundReason::DirectChildNotShell);
    assert!(ProcessProbe::new().foreground_program(pty.fd(), pty.pid));
}

#[test]
fn a_foreground_sleep_is_busy() {
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    pty.send("sleep 30");
    settles_to(&mut pty, ForegroundReason::ForegroundLeader);
}

#[test]
fn a_background_job_printing_every_five_minutes_keeps_the_terminal_busy() {
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    pty.send("(while :; do echo tick; sleep 300; done) &");
    assert!(pty.read_until("tick"), "{:?}", pty.text());
    settles_to(&mut pty, ForegroundReason::ShellAtPrompt);
    // The job is not a foreground program; it counts only through its output.
    let clock = FakeClock::new(5_000_000);
    let mut tracker = ActivityTracker::new(true, clock.now_ms());
    tracker.record_output(clock.now_ms());
    for _ in 0..4 {
        clock.advance(5 * MINUTE);
        assert!(
            tracker.pressure_busy(clock.now_ms()),
            "10-minute output window"
        );
        assert_eq!(
            tracker.evaluate_idle(clock.now_ms(), IdleTimings::default()),
            None
        );
        tracker.record_output(clock.now_ms());
    }
}

#[test]
fn a_silent_background_job_becomes_idle_after_ten_minutes() {
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    pty.send("sleep 120 &");
    assert!(pty.read_until("READY$ "));
    settles_to(&mut pty, ForegroundReason::ShellAtPrompt);
    assert_idle_closes_after_ten_minutes(false);
}

#[test]
fn a_nested_bash_at_its_prompt_is_idle_but_a_program_inside_it_is_busy() {
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    pty.send("PS1='NESTED$ ' bash --noprofile --norc -i");
    assert!(pty.read_until("NESTED$ "), "{:?}", pty.text());
    settles_to(&mut pty, ForegroundReason::NestedShell);
    assert!(!ProcessProbe::new().foreground_program(pty.fd(), pty.pid));
    match which("vim") {
        Some(_) => pty.send("vim -u NONE -N"),
        None => {
            eprintln!("vim is not installed; using sleep as the nested program");
            pty.send("sleep 30");
        }
    }
    settles_to(&mut pty, ForegroundReason::ForegroundLeader);
}

#[test]
fn a_root_owned_sudo_foreground_counts_as_a_program() {
    let passwordless = which("sudo").is_some_and(|sudo| {
        Command::new(sudo)
            .args(["-n", "true"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    });
    if !passwordless {
        eprintln!("skipping: passwordless sudo is not available");
        return;
    }
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    pty.send("sudo -n sleep 30");
    let busy = pty.wait_for(|pty| {
        matches!(
            reason(pty),
            ForegroundReason::ForegroundLeader | ForegroundReason::UnknownLeader
        )
    });
    assert!(busy, "{:?}", reason(&pty));
}

#[test]
fn tree_rss_covers_the_shell_and_its_children() {
    let Some(mut pty) = bash_or_skip() else {
        return;
    };
    let probe = ProcessProbe::new();
    let shell_only = probe.tree_rss(pty.pid).expect("the shell is alive");
    assert!(shell_only > 0);
    pty.send("sleep 30 &");
    assert!(pty.read_until("READY$ "));
    let with_child =
        pty.wait_for(|pty| probe.tree_rss(pty.pid).is_some_and(|rss| rss > shell_only));
    assert!(with_child, "a child adds resident memory to the tree");
    assert_eq!(
        probe.tree_rss_many(&[pty.pid, i32::MAX]).get(1),
        Some(&None)
    );
}
