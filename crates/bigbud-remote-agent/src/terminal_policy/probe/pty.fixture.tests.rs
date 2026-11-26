//! A minimal real PTY for probe tests: `forkpty` + `execve` of an absolute program, with
//! the whole session killed on drop.
#![cfg(unix)]

use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

pub(super) const WAIT: Duration = Duration::from_secs(10);

pub(super) fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .chain(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

pub(super) struct TestPty {
    master: File,
    pub(super) pid: i32,
    output: Vec<u8>,
}

impl TestPty {
    /// Starts an interactive bash with job control and the prompt `READY$ `.
    pub(super) fn bash() -> Option<Self> {
        let bash = which("bash")?;
        Some(Self::spawn(
            &bash,
            &["bash", "--noprofile", "--norc", "-i"],
            "READY$ ",
        ))
    }

    pub(super) fn spawn(program: &std::path::Path, argv: &[&str], prompt: &str) -> Self {
        let program = CString::new(program.as_os_str().as_encoded_bytes()).unwrap();
        let argv: Vec<CString> = argv.iter().map(|arg| CString::new(*arg).unwrap()).collect();
        let env: Vec<CString> = [
            format!("PATH={}", std::env::var("PATH").unwrap_or_default()),
            format!(
                "HOME={}",
                std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
            ),
            "TERM=xterm-256color".to_owned(),
            format!("PS1={prompt}"),
            "BASH_SILENCE_DEPRECATION_WARNING=1".to_owned(),
            "HISTFILE=/dev/null".to_owned(),
        ]
        .into_iter()
        .map(|entry| CString::new(entry).unwrap())
        .collect();
        let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());
        let mut env_ptrs: Vec<*const libc::c_char> =
            env.iter().map(|entry| entry.as_ptr()).collect();
        env_ptrs.push(std::ptr::null());
        let window = libc::winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let mut master_fd = -1;
        let gate = crate::spawn_gate::lock().unwrap();
        // SAFETY: argv/env storage outlives the fork; the child only calls execve and _exit.
        let pid = unsafe {
            libc::forkpty(
                &mut master_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &window as *const libc::winsize as *mut libc::winsize,
            )
        };
        assert!(
            pid >= 0,
            "forkpty failed: {}",
            std::io::Error::last_os_error()
        );
        if pid == 0 {
            // SAFETY: async-signal-safe calls only, with pointers prepared before fork.
            unsafe {
                libc::execve(program.as_ptr(), argv_ptrs.as_ptr(), env_ptrs.as_ptr());
                libc::_exit(127);
            }
        }
        // SAFETY: forkpty returned one owned master descriptor.
        let master = unsafe { File::from_raw_fd(master_fd) };
        // SAFETY: plain fcntl flag updates on the owned descriptor, still under the gate.
        unsafe {
            libc::fcntl(master_fd, libc::F_SETFD, libc::FD_CLOEXEC);
            let flags = libc::fcntl(master_fd, libc::F_GETFL);
            libc::fcntl(master_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        drop(gate);
        let mut pty = Self {
            master,
            pid,
            output: Vec::new(),
        };
        assert!(pty.read_until(prompt), "no prompt: {:?}", pty.text());
        pty
    }

    pub(super) fn fd(&self) -> i32 {
        self.master.as_raw_fd()
    }

    pub(super) fn send(&mut self, line: &str) {
        self.master.write_all(line.as_bytes()).unwrap();
        self.master.write_all(b"\r").unwrap();
    }

    pub(super) fn text(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }

    /// Reads until `needle` appears after everything seen so far was consumed.
    pub(super) fn read_until(&mut self, needle: &str) -> bool {
        let deadline = Instant::now() + WAIT;
        let start = self.output.len();
        while Instant::now() < deadline {
            self.pump(Duration::from_millis(50));
            if String::from_utf8_lossy(&self.output[start..]).contains(needle) {
                return true;
            }
        }
        false
    }

    /// Drains pending output so the child never blocks on a full PTY buffer.
    pub(super) fn pump(&mut self, timeout: Duration) {
        let mut poll = libc::pollfd {
            fd: self.fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let millis = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: one valid pollfd for the duration of the call.
        if unsafe { libc::poll(&mut poll, 1, millis) } <= 0 {
            return;
        }
        let mut buffer = [0u8; 4096];
        while let Ok(read) = self.master.read(&mut buffer) {
            if read == 0 {
                break;
            }
            self.output.extend_from_slice(&buffer[..read]);
        }
    }

    /// Polls `condition` while draining output.
    pub(super) fn wait_for(&mut self, mut condition: impl FnMut(&Self) -> bool) -> bool {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if condition(self) {
                return true;
            }
            self.pump(Duration::from_millis(50));
        }
        condition(self)
    }
}

impl Drop for TestPty {
    fn drop(&mut self) {
        // Background jobs live in their own process groups, so kill everything on this tty.
        // `ps -t` works on macOS and Linux (macOS `pkill` has no `-s` and its `-t` misses).
        // SAFETY: ptsname reads the owned master; the result is copied before any other call.
        let tty = unsafe {
            let name = libc::ptsname(self.fd());
            (!name.is_null()).then(|| {
                std::ffi::CStr::from_ptr(name)
                    .to_string_lossy()
                    .into_owned()
            })
        };
        if let Some(tty) = tty.as_deref().and_then(|tty| tty.strip_prefix("/dev/"))
            && let Ok(output) = Command::new("ps").args(["-t", tty, "-o", "pid="]).output()
        {
            for pid in String::from_utf8_lossy(&output.stdout).split_whitespace() {
                if let Ok(pid) = pid.parse::<i32>() {
                    // SAFETY: plain kill of a process attached to the test's own tty.
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            }
        }
        // SAFETY: signalling our own forkpty child.
        unsafe { libc::kill(self.pid, libc::SIGKILL) };
        // Close the master before reaping: on macOS an exiting process blocks in the tty
        // drain while undrained output sits in a PTY whose master is still open.
        let master = std::mem::replace(&mut self.master, File::open("/dev/null").unwrap());
        drop(master);
        // SAFETY: reaping our own child.
        unsafe { libc::waitpid(self.pid, std::ptr::null_mut(), 0) };
    }
}
