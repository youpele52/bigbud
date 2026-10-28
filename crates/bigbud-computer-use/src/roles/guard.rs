//! Guard role lifecycle (macOS, debug builds only until the M6 switch).
//!
//! Elects the durable root, recovers the retained safety record and runs the
//! guard service while `guard_control` serves the parent's control channel
//! (frames on stdin/stdout; stdin EOF is the lifeline), then performs the
//! bounded orderly shutdown. It never starts an owner or worker (no approved
//! generation exists), never opens admission and never clears a pause.
use super::guard_control::{ControlConfig, run_control};
use crate::guard::{
    ControllingLock, DurableRoot, GuardServiceConfig, GuardServiceControl, GuardServiceExit,
    LockError, RootLayout,
};
use std::{
    io::{Read, Write},
    path::Path,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

/// Exit statuses mirrored by `apps/desktop/src/computer-use/guardProcess.logic.ts`.
pub const EXIT_SETTLED: u8 = 0;
pub const EXIT_USAGE: u8 = 2;
pub const EXIT_STORAGE: u8 = 3;
pub const EXIT_CONFLICT: u8 = 4;
pub const EXIT_RECOVERY: u8 = 5;
pub const EXIT_UNSETTLED: u8 = 6;

/// The parent's lifeline (stdin EOF) is the only shutdown signal. A dev
/// terminal's Ctrl-C, hangup or a group-wide SIGTERM would otherwise kill the
/// guard without its orderly retirement; SIGKILL remains the forced stop.
/// Process-wide: call only from the guard executable's `main`. Dispositions
/// set to ignore survive `exec`, so any future child must reset them.
pub fn ignore_terminal_signals() {
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
        // SAFETY: installing SIG_IGN has no handler code and no preconditions.
        unsafe {
            libc::signal(signal, libc::SIG_IGN);
        }
    }
}

/// `guard [--development-root <absolute path ending in computer-use>]`.
pub fn parse_layout(args: &[String]) -> Result<RootLayout, u8> {
    match args {
        [] => Ok(RootLayout::Standard),
        [flag, path] if flag == "--development-root" => {
            RootLayout::development(Path::new(path)).map_err(|_| EXIT_USAGE)
        }
        _ => Err(EXIT_USAGE),
    }
}

pub fn run(
    args: &[String],
    input: impl Read + Send + 'static,
    output: impl Write + Send + 'static,
) -> u8 {
    let layout = match parse_layout(args) {
        Ok(layout) => layout,
        Err(code) => return code,
    };
    let lock = DurableRoot::acquire_current_user_in(&layout)
        .map_err(|_| EXIT_STORAGE)
        .and_then(elect);
    match lock {
        Ok(lock) => serve(lock, input, output),
        Err(code) => code,
    }
}

/// Election on an acquired root (tests use isolated fixture roots).
pub(crate) fn elect(root: DurableRoot) -> Result<ControllingLock, u8> {
    root.lock().map_err(|error| match error {
        LockError::Conflict => EXIT_CONFLICT,
        _ => EXIT_STORAGE,
    })
}

/// Distinguishes guard processes in Hello; identification, not authority.
fn instance_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("guard-{}-{nanos}", std::process::id())
}

/// Serves until the control channel ends, then shuts down; the election
/// drops on return.
pub(crate) fn serve(
    lock: ControllingLock,
    input: impl Read + Send + 'static,
    output: impl Write + Send + 'static,
) -> u8 {
    serve_with(lock, input, output, ControlConfig::default())
}

pub(crate) fn serve_with(
    mut lock: ControllingLock,
    input: impl Read + Send + 'static,
    output: impl Write + Send + 'static,
    config: ControlConfig,
) -> u8 {
    let mut recovery = lock.recover_retained();
    if recovery.failure().is_some() {
        return EXIT_RECOVERY;
    }
    let control = GuardServiceControl::default();
    let channel = control.clone();
    let retirement = recovery.session_invalidator().retirement_requests();
    let instance = instance_id();
    // Detached on purpose: if the service ends on its own, the guard must
    // exit (releasing the election) without waiting for the channel.
    thread::spawn(move || {
        run_control(input, output, &channel, &retirement, &instance, config);
    });
    let report = recovery.run_guard_service(&control, GuardServiceConfig::default());
    match report.exit {
        GuardServiceExit::ShutdownSettled if report.storage_ok => EXIT_SETTLED,
        _ => EXIT_UNSETTLED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::test_support::TestDirectory;
    use std::{
        io,
        os::unix::net::UnixStream,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn terminal_signals_do_not_kill_the_guard() {
        // Regression (review P3): Ctrl-C in the dev terminal killed the guard
        // without its orderly shutdown. Runs in a re-executed copy of this
        // test binary so the test process itself keeps default dispositions.
        if std::env::var_os("BIGBUD_GUARD_SIGNAL_CHILD").is_some() {
            ignore_terminal_signals();
            for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
                // SAFETY: raising a signal whose disposition is SIG_IGN.
                unsafe {
                    libc::raise(signal);
                }
            }
            // Surviving to return is the child's success.
            return;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "roles::guard::tests::terminal_signals_do_not_kill_the_guard",
                "--exact",
                "--quiet",
            ])
            .env("BIGBUD_GUARD_SIGNAL_CHILD", "1")
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "{status:?}");
    }

    #[test]
    fn parses_only_the_two_supported_forms() {
        assert_eq!(parse_layout(&[]), Ok(RootLayout::Standard));
        assert!(matches!(
            parse_layout(&strings(&[
                "--development-root",
                "/Users/u/.bigbud/dev/computer-use"
            ])),
            Ok(RootLayout::Development(_))
        ));
        for bad in [
            strings(&["--development-root"]),
            strings(&["--development-root", "relative/computer-use"]),
            strings(&["--development-root", "/Users/u/.bigbud/dev/other"]),
            strings(&["--root", "/Users/u/computer-use"]),
            strings(&["--development-root", "/a/computer-use", "extra"]),
        ] {
            assert_eq!(parse_layout(&bad), Err(EXIT_USAGE), "{bad:?}");
        }
    }

    #[test]
    fn a_root_outside_the_account_home_is_refused_before_any_write() {
        let fixture = TestDirectory::new();
        let target = fixture.0.join("computer-use");
        let code = run(
            &strings(&["--development-root", target.to_str().unwrap()]),
            io::empty(),
            io::sink(),
        );
        assert_eq!(code, EXIT_STORAGE);
        assert!(!target.exists());
    }

    #[test]
    fn lifeline_eof_settles_and_a_second_guard_reports_conflict() {
        let fixture = TestDirectory::new();
        let held = elect(DurableRoot::fixture(&fixture.0, true).unwrap()).unwrap();
        // While the first guard holds the election, another guard conflicts.
        assert_eq!(
            elect(DurableRoot::fixture(&fixture.0, true).unwrap()).err(),
            Some(EXIT_CONFLICT)
        );
        let (parent, child) = UnixStream::pair().unwrap();
        let (done, finished) = mpsc::channel();
        let guard = thread::spawn(move || done.send(serve(held, child, io::sink())).unwrap());
        thread::sleep(Duration::from_millis(150));
        assert!(
            finished.try_recv().is_err(),
            "guard must run until lifeline EOF"
        );
        let stopped = Instant::now();
        drop(parent); // Parent death or explicit stop closes the lifeline.
        let code = finished.recv_timeout(Duration::from_secs(10)).unwrap();
        guard.join().unwrap();
        assert_eq!(code, EXIT_SETTLED);
        assert!(
            stopped.elapsed() < Duration::from_secs(6),
            "bounded shutdown"
        );
        // The election is released after an orderly exit.
        let again = elect(DurableRoot::fixture(&fixture.0, true).unwrap()).unwrap();
        assert_eq!(serve(again, io::empty(), io::sink()), EXIT_SETTLED);
    }
}
