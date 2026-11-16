#![allow(clippy::unwrap_used, clippy::panic)]

use super::*;
use std::fs::{self, Permissions};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

struct Root(PathBuf);

impl Root {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("bigbud-log-{}-{stamp}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn private_file(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn sustained_and_oversized_writes_keep_two_hard_capped_suffix_files() {
    let root = Root::new();
    let mut log = files::RotatingLog::open(&root.0, 64).unwrap();
    let bytes: Vec<u8> = (0..231).collect();
    for piece in bytes.chunks(7) {
        log.write_all(piece).unwrap();
    }
    assert_eq!(
        fs::read(root.0.join("supervisor.log.1")).unwrap(),
        bytes.get(128..192).unwrap()
    );
    assert_eq!(
        fs::read(root.0.join("supervisor.log")).unwrap(),
        bytes.get(192..).unwrap()
    );
    log.write_all(&vec![b'x'; CHUNK_BYTES * 2]).unwrap();
    for name in ["supervisor.log", "supervisor.log.1"] {
        assert!(fs::metadata(root.0.join(name)).unwrap().len() <= 64);
    }
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
}

#[test]
fn bounds_oversized_startup_logs_preserving_their_suffixes() {
    let root = Root::new();
    for name in ["supervisor.log", "supervisor.log.1"] {
        private_file(&root.0.join(name), b"discarded-old-prefix-keep-tail");
    }
    let _log = files::RotatingLog::open(&root.0, 9).unwrap();
    for name in ["supervisor.log", "supervisor.log.1"] {
        assert_eq!(fs::read(root.0.join(name)).unwrap(), b"keep-tail");
    }
}

#[test]
fn refuses_symlinks_hardlinks_and_nonprivate_files_before_truncation() {
    for kind in ["symlink", "hardlink", "public", "directory"] {
        let root = Root::new();
        let outside = Root::new();
        let target = outside.0.join("target");
        private_file(&target, b"do-not-change");
        let current = root.0.join("supervisor.log");
        private_file(&current, b"oversized-current-must-remain");
        let previous = root.0.join("supervisor.log.1");
        match kind {
            "symlink" => symlink(&target, &previous).unwrap(),
            "hardlink" => fs::hard_link(&target, &previous).unwrap(),
            "public" => {
                private_file(&previous, b"public");
                fs::set_permissions(&previous, Permissions::from_mode(0o644)).unwrap();
            }
            "directory" => fs::create_dir(&previous).unwrap(),
            _ => panic!("unknown fixture"),
        }
        assert!(files::RotatingLog::open(&root.0, 4).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"do-not-change");
        assert_eq!(
            fs::read(&current).unwrap(),
            b"oversized-current-must-remain"
        );
    }
}

#[test]
fn refuses_symlink_or_shared_root() {
    let root = Root::new();
    let parent = Root::new();
    let link = parent.0.join("link");
    symlink(&root.0, &link).unwrap();
    assert!(files::RotatingLog::open(&link, 64).is_err());
    fs::set_permissions(&root.0, Permissions::from_mode(0o755)).unwrap();
    assert!(files::RotatingLog::open(&root.0, 64).is_err());
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
}

#[test]
fn unlink_or_new_hardlink_stops_writes_without_touching_replacements() {
    for unlink in [false, true] {
        let root = Root::new();
        let outside = Root::new();
        let mut log = files::RotatingLog::open(&root.0, 64).unwrap();
        let current = root.0.join("supervisor.log");
        if unlink {
            fs::remove_file(&current).unwrap();
            private_file(&current, b"replacement");
        } else {
            fs::hard_link(&current, outside.0.join("alias")).unwrap();
        }
        assert!(log.write_all(b"must-not-write").is_err());
        if unlink {
            assert_eq!(fs::read(&current).unwrap(), b"replacement");
        } else {
            assert!(fs::read(outside.0.join("alias")).unwrap().is_empty());
        }
    }
}

fn join_bounded<T>(worker: JoinHandle<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !worker.is_finished() && Instant::now() < deadline {
        thread::sleep(POLL);
    }
    assert!(worker.is_finished(), "logger worker exceeded test deadline");
    worker.join().unwrap()
}

#[test]
fn stalled_or_failed_sink_does_not_stop_fd_draining() {
    for disconnected in [false, true] {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        reader.set_read_timeout(Some(POLL)).unwrap();
        writer
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CHUNKS);
        let held_receiver = if disconnected {
            drop(receiver);
            None
        } else {
            Some(receiver)
        };
        let omitted = Arc::new(AtomicU64::new(0));
        let count = Arc::clone(&omitted);
        let worker = thread::spawn(move || drain(reader, sender, &AtomicBool::new(false), &count));
        writer.write_all(&vec![b'x'; 1024 * 1024]).unwrap();
        drop(writer);
        join_bounded(worker).unwrap();
        assert!(omitted.load(Ordering::Relaxed) > 0);
        if let Some(receiver) = held_receiver {
            let chunks: Vec<_> = receiver.try_iter().collect();
            assert!(chunks.len() <= QUEUE_CHUNKS);
            assert!(chunks.iter().all(|chunk| chunk.len() <= CHUNK_BYTES));
        }
    }
}

#[test]
fn shutdown_does_not_wait_for_inherited_writer_eof() {
    let (reader, _still_open_writer) = UnixStream::pair().unwrap();
    reader.set_read_timeout(Some(POLL)).unwrap();
    let (sender, _receiver) = mpsc::sync_channel(QUEUE_CHUNKS);
    let worker =
        thread::spawn(move || drain(reader, sender, &AtomicBool::new(true), &AtomicU64::new(0)));
    join_bounded(worker).unwrap();
}

#[test]
fn stalled_disk_shutdown_is_explicitly_unconfirmed_at_deadline() {
    let (release, blocked) = mpsc::channel();
    let (done, finished) = mpsc::channel();
    let worker = thread::spawn(move || {
        blocked.recv().unwrap();
        done.send(()).unwrap();
        Ok(())
    });
    let running = Running {
        null: File::options().write(true).open("/dev/null").unwrap(),
        stop: Arc::new(AtomicBool::new(false)),
        workers: vec![worker],
        captured: false,
    };
    let error = running.stop_until(Instant::now() + POLL).unwrap_err();
    // Release the synthetic blocked syscall; no test worker remains blocked.
    release.send(()).unwrap();
    finished.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(error.to_string(), "logger shutdown unconfirmed");
}

#[test]
fn refuses_invalid_file_caps() {
    let root = Root::new();
    assert!(files::RotatingLog::open(&root.0, 0).is_err());
    assert!(files::RotatingLog::open(&root.0, FILE_BYTES + 1).is_err());
}

#[test]
fn a_second_logger_cannot_mutate_the_active_log_pair() {
    let root = Root::new();
    let mut first = files::RotatingLog::open(&root.0, 64).unwrap();
    first.write_all(b"active-log").unwrap();
    assert!(files::RotatingLog::open(&root.0, 4).is_err());
    assert_eq!(
        fs::read(root.0.join("supervisor.log")).unwrap(),
        b"active-log"
    );
    drop(first);
    assert!(files::RotatingLog::open(&root.0, 64).is_ok());
}

#[test]
fn records_omission_and_propagates_disk_full_without_retry_loop() {
    let (sender, receiver) = mpsc::sync_channel(1);
    sender.send(b"retained".to_vec()).unwrap();
    drop(sender);
    let mut bytes = Vec::new();
    write_log(&mut bytes, receiver, &AtomicU64::new(123)).unwrap();
    assert!(
        String::from_utf8(bytes)
            .unwrap()
            .contains("123 diagnostic bytes omitted")
    );
    struct Full;
    impl Write for Full {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::from_raw_os_error(libc::ENOSPC))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    sender.send(b"diagnostic".to_vec()).unwrap();
    drop(sender);
    assert_eq!(
        write_log(Full, receiver, &AtomicU64::new(0))
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ENOSPC)
    );
}

#[test]
fn actual_stderr_is_captured_on_normal_finish_and_process_exit() {
    for mode in ["finish", "exit"] {
        let root = Root::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "supervisor::logging::tests::stderr_child",
                "--nocapture",
            ])
            .env("BIGBUD_TEST_LOG_ROOT", &root.0)
            .env("BIGBUD_TEST_LOG_EXIT", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("logger child hung");
            }
            thread::sleep(POLL);
        };
        assert!(status.success());
        let log = fs::read_to_string(root.0.join("supervisor.log")).unwrap();
        assert!(log.contains("direct-fd2-final-marker"));
        for name in ["supervisor.log", "supervisor.log.1"] {
            assert!(fs::metadata(root.0.join(name)).unwrap().len() <= 256);
        }
    }
}

#[test]
#[allow(clippy::exit)]
fn stderr_child() {
    let Some(root) = std::env::var_os("BIGBUD_TEST_LOG_ROOT") else {
        return;
    };
    let logging = SupervisorLogging::start_with_limit(Path::new(&root), 256).unwrap();
    // Direct std::io stderr bypasses the test harness's print capture.
    for _ in 0..12 {
        io::stderr().write_all(&[b'x'; 64]).unwrap();
        thread::sleep(Duration::from_millis(2));
    }
    io::stderr()
        .write_all(b"\ndirect-fd2-final-marker\n")
        .unwrap();
    if std::env::var("BIGBUD_TEST_LOG_EXIT").unwrap() == "exit" {
        std::process::exit(0);
    }
    // A real exec child inherits captured FD2. Logger teardown must not wait
    // for this unrelated writer to exit or send it a signal to obtain EOF.
    let mut inherited = Command::new("sleep").arg("10").spawn().unwrap();
    let result = logging.finish();
    let still_running = inherited.try_wait().unwrap().is_none();
    if still_running {
        inherited.kill().unwrap();
    }
    inherited.wait().unwrap();
    result.unwrap();
    assert!(
        still_running,
        "logging shutdown interrupted the inherited writer"
    );
}
