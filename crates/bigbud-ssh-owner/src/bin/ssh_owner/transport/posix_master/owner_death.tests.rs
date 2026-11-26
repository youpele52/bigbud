use super::arm;
use std::{
    process::Command,
    time::{Duration, Instant},
};

fn exited_within(child: &mut std::process::Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if child.try_wait().expect("try_wait").is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn closing_the_owner_end_kills_the_master() {
    let mut master = Command::new("/bin/sleep").arg("30").spawn().expect("spawn");
    let watch = arm(master.id()).expect("arm");
    // Same kernel path as an owner exit or SIGKILL: the only write end closes.
    drop(watch);
    assert!(exited_within(&mut master, Duration::from_secs(5)));
}

#[test]
fn a_disarmed_watch_never_signals_the_master() {
    let mut master = Command::new("/bin/sleep").arg("30").spawn().expect("spawn");
    let watch = arm(master.id()).expect("arm");
    watch.disarm();
    assert!(!exited_within(&mut master, Duration::from_millis(300)));
    master.kill().expect("kill");
    master.wait().expect("wait");
}
