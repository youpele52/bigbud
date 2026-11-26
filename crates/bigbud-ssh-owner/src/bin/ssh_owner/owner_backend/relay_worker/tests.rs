use super::{Outcome, supervise};
use std::{
    os::unix::process::CommandExt,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn child(script: &str) -> Child {
    match Command::new("/bin/sh")
        .args(["-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => panic!("spawn: {error}"),
    }
}

#[test]
fn ordinary_exit_and_a_refused_pin_are_distinct() {
    assert_eq!(
        supervise(&mut child("exit 3"), || false),
        Outcome::Exited(3)
    );
    assert_eq!(
        supervise(&mut child("exit 0"), || false),
        Outcome::Exited(0)
    );
    assert_eq!(
        supervise(&mut child("exit 126"), || false),
        Outcome::Refused
    );
    assert_eq!(supervise(&mut child("kill -9 $$"), || false), Outcome::Lost);
}

#[test]
fn close_kills_the_whole_group_and_confirms_reap() {
    let started = Instant::now();
    let outcome = supervise(&mut child("sleep 30 & sleep 30; wait"), || {
        started.elapsed() > Duration::from_millis(50)
    });
    assert_eq!(outcome, Outcome::Closed);
    assert!(started.elapsed() < Duration::from_secs(5));
}
