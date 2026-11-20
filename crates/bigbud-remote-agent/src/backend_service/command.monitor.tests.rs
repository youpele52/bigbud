#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use std::os::unix::process::CommandExt;
#[test]
fn observer_failure_still_cancels_owned_descendants_and_preserves_original_error() {
    let root = std::env::temp_dir().join(format!("bigbud-monitor-observer-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let sentinel = root.join("late-write");
    let mut child = Command::new("/bin/sh")
        .args([
            "-c",
            r#"(sleep .3; printf late > "$1") & sleep 10"#,
            "fixture",
        ])
        .arg(&sentinel)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut observations = 0;
    let result = cleanup_observing(&mut child, |_| {
        observations += 1;
        Err(ServiceError::Invalid("injected kernel observation failure"))
    });
    assert!(matches!(
        result,
        Err(ServiceError::Invalid("injected kernel observation failure"))
    ));
    assert!(
        observations > 1,
        "cleanup must retry with the same retained leader lease"
    );
    assert!(child.try_wait().unwrap().is_some());
    assert!(!sentinel.exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[cfg(target_os = "macos")]
fn natural_exit_between_observation_and_signal_requires_fresh_stopped_proof() {
    let mut child = exited_child();
    let mut calls = 0;
    let result = cleanup_observing(&mut child, |pid| {
        calls += 1;
        if calls == 1 {
            Ok((false, false))
        }
        // stale result immediately before natural exit
        else {
            Ok((group::exited(pid)?, group::descendants_remain(pid)?))
        }
    });
    assert!(
        result.is_ok(),
        "fresh stopped proof must qualify zombie-only EPERM: {result:?}"
    );
    assert!(calls >= 2);
    assert_eq!(child.wait().unwrap().code(), Some(17));
}

#[cfg(target_os = "macos")]
fn exited_child() -> Child {
    let child = Command::new("/bin/sh")
        .args(["-c", "exit 17"])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id() as i32;
    let deadline = Instant::now() + Duration::from_secs(2);
    while !group::exited(pid).unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    child
}
#[test]
#[cfg(target_os = "macos")]
fn fresh_stopped_proof_never_erases_an_earlier_observation_failure() {
    let mut child = exited_child();
    let mut calls = 0;
    let result = cleanup_observing(&mut child, |pid| {
        calls += 1;
        if calls == 1 {
            Err(ServiceError::Invalid("earlier observation failure"))
        } else {
            Ok((group::exited(pid)?, group::descendants_remain(pid)?))
        }
    });
    assert!(matches!(
        result,
        Err(ServiceError::Invalid("earlier observation failure"))
    ));
    assert!(calls >= 2);
    assert_eq!(child.wait().unwrap().code(), Some(17));
}
