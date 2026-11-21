//! A terminating close ends every process of the PTY: interactive shells (which ignore
//! SIGTERM), their foreground jobs, and children that trap SIGHUP and SIGTERM (R8).

use super::super::*;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

struct Spawned {
    handle: Arc<PtyHandle>,
    reader: std::thread::JoinHandle<Vec<u8>>,
    tty: String,
}

fn spawn(name: &str, shell: &str, args: &[&str]) -> Spawned {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = format!(
        "close-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let job = PtyHandle::spawn(id, Path::new("/tmp"), shell, &args, 80, 24, &[]).unwrap();
    let handle = Arc::clone(&job.handle);
    let reader_handle = Arc::clone(&job.handle);
    // The job thread is the only reaper, as in the supervisor.
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        run_events(job.reader, &reader_handle, |event| {
            if let PtyEvent::Output(bytes) = event {
                output.extend_from_slice(&bytes);
            }
        });
        output
    });
    let tty = tty_of(handle.pid);
    assert!(
        !tty.is_empty() && tty != "??",
        "{name}: no controlling terminal"
    );
    Spawned {
        handle,
        reader,
        tty,
    }
}

fn tty_of(pid: u32) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = Command::new("ps")
            .args(["-o", "tty=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let tty = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if (!tty.is_empty() && tty != "??") || Instant::now() >= deadline {
            return tty;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Processes still attached to the terminal.
fn left_on(tty: &str) -> String {
    let output = Command::new("ps")
        .args(["-t", tty, "-o", "pid=,stat=,comm="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn close_and_check(spawned: Spawned, name: &str, min: Duration) {
    let started = Instant::now();
    spawned.handle.close(true).unwrap();
    let outcome = spawned.handle.wait_closed(PtyHandle::close_deadline());
    let took = started.elapsed();
    assert_eq!(outcome, CloseOutcome::Reaped, "{name} survived the close");
    assert!(took >= min, "{name} closed in {took:?}");
    assert!(!spawned.handle.close_outcome_unknown());
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut left = left_on(&spawned.tty);
    while !left.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        left = left_on(&spawned.tty);
    }
    assert!(
        left.is_empty(),
        "{name} left processes on {}: {left}",
        spawned.tty
    );
    let _output = spawned.reader.join().unwrap();
    eprintln!("{name}: closed in {took:?}");
}

fn interactive_shells() -> Vec<(&'static str, &'static str, Vec<&'static str>)> {
    [
        ("sh", "/bin/sh", vec!["-i"]),
        ("zsh", "/bin/zsh", vec!["-f", "-i"]),
        ("bash", "/bin/bash", vec!["--norc", "--noprofile", "-i"]),
    ]
    .into_iter()
    .filter(|(_, path, _)| Path::new(path).exists())
    .collect()
}

#[test]
fn interactive_shells_that_ignore_sigterm_are_gone_after_close() {
    for (name, shell, args) in interactive_shells() {
        let spawned = spawn(name, shell, &args);
        std::thread::sleep(Duration::from_millis(300));
        close_and_check(spawned, name, Duration::ZERO);
    }
}

#[test]
fn a_foreground_job_of_an_interactive_shell_is_ended_with_it() {
    for (name, shell, args) in interactive_shells() {
        let spawned = spawn(name, shell, &args);
        std::thread::sleep(Duration::from_millis(300));
        spawned.handle.write_input(1, b"sleep 300\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !left_on(&spawned.tty).contains("sleep") {
            assert!(Instant::now() < deadline, "{name}: the job never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        close_and_check(
            spawned,
            &format!("{name} with a foreground job"),
            Duration::ZERO,
        );
    }
}

#[test]
fn a_child_trapping_hup_and_term_is_killed_by_the_escalation() {
    let script = "trap '' HUP TERM; while :; do sleep 1; done";
    let spawned = spawn("trap", "/bin/sh", &["-c", script]);
    std::thread::sleep(Duration::from_millis(300));
    close_and_check(spawned, "trapping child", CLOSE_GRACE);
}

#[test]
fn closing_twice_and_closing_an_exited_pty_are_harmless() {
    let spawned = spawn("twice", "/bin/sh", &["-c", "exit 0"]);
    let _ = spawned
        .handle
        .wait_closed(Instant::now() + Duration::from_secs(5));
    spawned.handle.close(true).unwrap();
    spawned.handle.close(true).unwrap();
    assert_eq!(
        spawned
            .handle
            .wait_closed(Instant::now() + Duration::from_secs(1)),
        CloseOutcome::Reaped
    );
    let _output = spawned.reader.join().unwrap();
}
