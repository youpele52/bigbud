use super::*;
use crate::process::{ProcessOptions, run_bounded_process};
use crate::pty::{PtyHandle, read_events};
use std::cell::RefCell;
use std::sync::mpsc;
use std::time::Duration;

type Hook = Box<dyn FnOnce(i32) -> io::Result<()>>;
thread_local! { static BEFORE: RefCell<Option<Hook>> = RefCell::new(None); }
pub(super) fn before_setup(fd: i32) -> io::Result<()> {
    BEFORE.with(|hook| match hook.borrow_mut().take() {
        Some(hook) => hook(fd),
        None => Ok(()),
    })
}

#[test]
fn concurrent_production_command_spawn_cannot_inherit_a_pty_master_during_cloexec_setup() {
    let (created, master) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    let pty_worker = std::thread::spawn(move || {
        BEFORE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |fd| {
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                // SAFETY: master is live and exclusively owned; stat is writable.
                assert_eq!(unsafe { libc::fstat(fd, stat.as_mut_ptr()) }, 0);
                // SAFETY: successful fstat initialized the complete native stat.
                let stat = unsafe { stat.assume_init() };
                created.send((fd, stat.st_dev, stat.st_ino)).unwrap();
                resumed.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(())
            }))
        });
        PtyHandle::spawn(
            "inheritance".into(),
            &std::env::current_dir().unwrap(),
            "sh",
            &["-c".into(), "printf done".into()],
            80,
            24,
            &[],
        )
        .unwrap()
    });
    let (fd, device, inode) = master.recv_timeout(Duration::from_secs(3)).unwrap();
    let (started, ready) = mpsc::channel();
    let (finished, done) = mpsc::channel();
    let process_worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        let module = module_path!()
            .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
            .unwrap();
        let result = run_bounded_process(
            &std::env::current_dir().unwrap(),
            std::env::current_exe().unwrap().to_str().unwrap(),
            &[
                "--exact".into(),
                format!("{module}::inherited_descriptor_helper"),
                "--nocapture".into(),
            ],
            ProcessOptions {
                environment: &[(
                    "BIGBUD_TEST_MASTER_STAT".into(),
                    format!("{fd}/{device}/{inode}"),
                )],
                stdin_bytes: &[],
                timeout: Duration::from_secs(3),
                max_output_bytes: 4096,
                cancellation: None,
            },
        )
        .unwrap();
        finished.send(()).unwrap();
        result
    });
    ready.recv().unwrap();
    assert!(
        done.recv_timeout(Duration::from_millis(100)).is_err(),
        "spawn escaped the shared descriptor gate"
    );
    resume.send(()).unwrap();
    let job = pty_worker.join().unwrap();
    let result = process_worker.join().unwrap();
    assert_eq!(
        result.exit_code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    read_events(job.reader, &job.handle);
}

#[test]
fn failed_postfork_setup_transfers_child_to_owned_pending_reap_registry() {
    BEFORE.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(|_| {
            Err(io::Error::other("injected setup failure"))
        }))
    });
    assert!(
        PtyHandle::spawn(
            "setup-failure".into(),
            &std::env::current_dir().unwrap(),
            "sh",
            &["-c".into(), "trap '' TERM HUP; sleep 30".into()],
            80,
            24,
            &[]
        )
        .is_err()
    );
    let pending = super::super::cleanup::retained_children();
    assert!(!pending.is_empty(), "failed child must not be abandoned");
    let _owner = super::super::cleanup::CleanupOwner::start().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while pending.iter().any(|child| !child.reaped()) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(pending.iter().all(|child| child.reaped()));
}

#[test]
fn inherited_descriptor_helper() {
    let Ok(identity) = std::env::var("BIGBUD_TEST_MASTER_STAT") else {
        return;
    };
    let fields = identity.split('/').collect::<Vec<_>>();
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fstat only inspects this process's numeric fd; no signal or mutation.
    if unsafe { libc::fstat(fields[0].parse::<i32>().unwrap(), stat.as_mut_ptr()) } == 0 {
        // SAFETY: successful fstat initialized stat, even if fd was reused by stdio.
        let stat = unsafe { stat.assume_init() };
        assert_ne!(
            (stat.st_dev.to_string(), stat.st_ino.to_string()),
            (fields[1].to_owned(), fields[2].to_owned()),
            "inherited unrelated PTY master"
        );
    }
}
