use super::*;
use crate::pty::{PtyHandle, PtyJob};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    job: PtyJob,
    member: Option<Process>,
    root: PathBuf,
}

impl Fixture {
    fn new(resistant: bool) -> Self {
        let script = if resistant {
            "set -m; sh -c 'trap \"\" TERM HUP; echo $$ > member; while :; do sleep 1; done' & wait"
        } else {
            "set -m; sh -c 'trap \"\" HUP; echo $$ > member; exec sleep 30' & wait"
        };
        Self::script(script)
    }

    fn script(script: &str) -> Self {
        let serial = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("pty-stop-{}-{serial}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let job = PtyHandle::spawn(
            format!("session-stop-{serial}"),
            &root,
            "sh",
            &["-c".into(), script.into()],
            80,
            24,
            &[],
        )
        .unwrap();
        // Construct cleanup ownership before any assertion about fixture readiness.
        let mut fixture = Self {
            job,
            member: None,
            root,
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        let pid = loop {
            if let Ok(text) = std::fs::read_to_string(fixture.root.join("member"))
                && let Ok(pid) = text.trim().parse::<i32>()
            {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "job-control fixture did not become ready"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        let identity = Identity::read(pid).unwrap();
        fixture.member = Process::open(identity).unwrap();
        assert!(fixture.member.is_some());
        assert_eq!(identity.session, fixture.job.handle.pid as i32);
        // SAFETY: read-only process group query; fixture's live pidfd retains identity.
        assert_ne!(unsafe { libc::getpgid(pid) }, fixture.job.handle.pid as i32);
        fixture
    }

    fn wait_reaped(&self) {
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            if self.job.handle.inner.child.poll().unwrap().is_some() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "session termination did not settle"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Fixture-only cleanup also handles the intentionally broken old group
        // implementation: pin the background job independently before testing.
        if let Some(member) = &self.member {
            let _ = member.signal(libc::SIGKILL);
        }
        let _ = self.job.handle.force_kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self
                .job
                .handle
                .inner
                .child
                .poll()
                .is_ok_and(|exit| exit.is_some())
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn stop_covers_job_control_group_and_preserves_sibling_session() {
    let selected = Fixture::new(false);
    let sibling = Fixture::new(false);
    selected.job.handle.signal("SIGTERM").unwrap();
    selected.wait_reaped();
    assert!(selected.member.as_ref().unwrap().exited().unwrap());
    assert!(!sibling.member.as_ref().unwrap().exited().unwrap());
    assert!(sibling.job.handle.inner.child.poll().unwrap().is_none());
    assert_eq!(
        Identity::read(std::process::id() as i32).unwrap().pid,
        std::process::id() as i32
    );
    // Retained terminal handles must never regain native signalling authority.
    selected.job.handle.force_kill().unwrap();
    assert!(!sibling.member.as_ref().unwrap().exited().unwrap());
}

#[test]
fn leader_exit_does_not_certify_term_resistant_job_and_force_remains_possible() {
    let selected = Fixture::new(true);
    let leader = selected.job.handle.pid as i32;
    selected.job.handle.signal("SIGTERM").unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !leader_exited(leader).unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..4 {
        assert!(selected.job.handle.inner.child.poll().unwrap().is_none());
        assert!(!selected.job.handle.child_reaped());
        assert!(!selected.member.as_ref().unwrap().exited().unwrap());
        std::thread::sleep(RESCAN_INTERVAL);
    }
    selected.job.handle.force_kill().unwrap();
    selected.wait_reaped();
    assert!(selected.member.as_ref().unwrap().exited().unwrap());
}

#[test]
fn natural_shell_exit_retains_jobs_without_signalling_and_later_stop_works() {
    let selected = Fixture::script(
        r#"set -m; sh -c 'trap "" HUP; echo $$ > member; exec sleep 30' & while [ ! -s member ]; do sleep 0.01; done; exit 0"#,
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while !leader_exited(selected.job.handle.pid as i32).unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..3 {
        assert!(selected.job.handle.inner.child.poll().unwrap().is_none());
        assert!(!selected.job.handle.child_reaped());
        assert!(!selected.member.as_ref().unwrap().exited().unwrap());
        std::thread::sleep(RESCAN_INTERVAL);
    }
    selected.job.handle.signal("SIGTERM").unwrap();
    selected.wait_reaped();
    assert!(selected.member.as_ref().unwrap().exited().unwrap());
}

#[test]
fn mismatched_identity_refuses_pin_and_exited_pidfd_cannot_signal_sibling() {
    let selected = Fixture::new(false);
    let sibling = Fixture::new(false);
    let member = selected.member.as_ref().unwrap();
    let mut wrong = member.identity;
    wrong.started = wrong.started.checked_add(1).unwrap();
    assert!(Process::open(wrong).is_err());
    selected.job.handle.force_kill().unwrap();
    selected.wait_reaped();
    member.signal(libc::SIGKILL).unwrap();
    assert!(!sibling.member.as_ref().unwrap().exited().unwrap());
}

#[test]
fn rescan_terminates_job_forked_by_a_signal_trap_before_reporting_exit() {
    let selected = Fixture::script(
        r#"set -m; sh -c 'trap "" HUP; trap "sleep 30 & echo \$! > late; exit 0" TERM; echo $$ > member; while :; do sleep 1; done' & wait"#,
    );
    selected.job.handle.signal("SIGTERM").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let late = loop {
        if let Ok(text) = std::fs::read_to_string(selected.root.join("late"))
            && let Ok(pid) = text.trim().parse::<i32>()
        {
            break Process::open(Identity::read(pid).unwrap())
                .unwrap()
                .unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "signal trap did not fork fixture job"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    // No reap polling ran while the trap forked, so the new job was not part of
    // the initial inventory. The next discovery must find it under the held SID.
    assert_eq!(late.identity.session, selected.job.handle.pid as i32);
    selected.wait_reaped();
    assert!(late.exited().unwrap());
}

#[test]
fn failed_discovery_keeps_termination_fence_before_any_native_reap() {
    // Real child with deliberately poisoned observation state: no signal or
    // leader reap may proceed, and force remains an explicit failed operation.
    let selected = Fixture::new(false);
    let child = Arc::clone(&selected.job.handle.inner.child);
    let poison = Arc::clone(&child);
    let result = std::thread::spawn(move || {
        let _guard = poison.stopping.lock().unwrap();
        panic!("injected cleanup observer failure");
    })
    .join();
    assert!(result.is_err());
    assert!(child.signal(libc::SIGTERM).is_err());
    assert!(child.poll().is_err());
    assert!(!child.reaped());
    // Restore test-only observer state before owned cleanup. Never recover a
    // poisoned production authority; use the still-unreaped direct child here.
    child.stopping.clear_poison();
    // poll marked authority Unknown; test fixture must not leave this real child.
    *child.authority.lock().unwrap() = super::super::Authority::Live;
}

#[test]
fn unrelated_non_utf8_comm_does_not_block_selected_stop() {
    let selected = Fixture::new(false);
    let sibling = Fixture::script(
        r#"set -m; sh -c 'trap "" HUP; echo $$ > member; while [ ! -e rename ]; do :; done; printf "\377)opaque" > /proc/$$/comm; echo ready > renamed; while :; do sleep 1; done' & wait"#,
    );
    let pid = sibling.member.as_ref().unwrap().identity.pid;
    std::fs::write(sibling.root.join("rename"), b"go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !sibling.root.join("renamed").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        std::fs::read(format!("/proc/{pid}/stat"))
            .unwrap()
            .contains(&255)
    );
    selected.job.handle.signal("SIGTERM").unwrap();
    selected.wait_reaped();
    assert!(selected.member.as_ref().unwrap().exited().unwrap());
    assert!(!sibling.member.as_ref().unwrap().exited().unwrap());
    assert!(sibling.job.handle.inner.child.poll().unwrap().is_none());
}

#[test]
fn new_member_fork_and_exit_after_discovery_invalidates_empty_fence() {
    let selected = Fixture::script(
        r#"set -m; sh -c 'trap "" HUP; echo $$ > member; while [ ! -e release ]; do :; done; sleep 30 & echo $! > late; exit 0' & wait"#,
    );
    let leader = selected.job.handle.pid as i32;
    // SAFETY: this test owns the unreaped direct leader, and performs no
    // competing poll/reap. Kill only the shell; its HUP-immune job is retained.
    assert_eq!(unsafe { libc::kill(leader, libc::SIGKILL) }, 0);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !leader_exited(leader).unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut observation = Session::new();
    observation.empty_scan = true; // Exercise the second-observation boundary.
    let mut late = None;
    let settled = observation
        .observe_settlement(leader, || {
            // Discovery has pinned the live member. Only now let it fork a child
            // absent from that enumeration, then exit before the final pidfd poll.
            std::fs::write(selected.root.join("release"), b"go").unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok(text) = std::fs::read_to_string(selected.root.join("late"))
                    && let Ok(pid) = text.trim().parse::<i32>()
                    && selected.member.as_ref().unwrap().exited().unwrap()
                {
                    late = Process::open(Identity::read(pid).unwrap()).unwrap();
                    break;
                }
                assert!(Instant::now() < deadline, "member did not fork and exit");
                std::thread::sleep(Duration::from_millis(5));
            }
        })
        .unwrap();
    assert!(
        !settled,
        "new activity must invalidate the prior empty observation"
    );
    assert!(!observation.empty_scan);
    let late = late.unwrap();
    assert_eq!(late.identity.session, leader);
    assert!(!late.exited().unwrap());
    std::thread::sleep(RESCAN_INTERVAL);
    assert!(!observation.settled(leader).unwrap());
    assert!(
        observation
            .members
            .iter()
            .any(|member| member.identity == late.identity)
    );
    selected.job.handle.force_kill().unwrap();
    selected.wait_reaped();
    assert!(late.exited().unwrap());
}
