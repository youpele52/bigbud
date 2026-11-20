//! Optional, best-effort copy of a staged image to this host's clipboard. Only attempted when the
//! host has a usable clipboard (a graphical session); headless hosts are skipped silently, since
//! the pasted path is what the terminal program uses.

use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Most helpers fork into the background and their parent exits within milliseconds.
const SYNC_WAIT: Duration = Duration::from_millis(300);
/// A helper still running after this is killed by its reaper thread.
const REAPER_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardOutcome {
    Set,
    Unavailable,
}

impl ClipboardOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Set => "set",
            Self::Unavailable => "unavailable",
        }
    }
}

struct Helper {
    program: PathBuf,
    args: Vec<OsString>,
    stdin_from_file: bool,
}

/// `xsel` is not used: it can only publish text targets, never an image MIME type.
#[cfg(all(unix, not(target_os = "macos")))]
fn helper_for(
    path: &Path,
    mime_type: &str,
    env: &dyn Fn(&str) -> Option<OsString>,
) -> Option<Helper> {
    let present = |name: &str| env(name).is_some_and(|value| !value.is_empty());
    if present("WAYLAND_DISPLAY")
        && let Some(program) = find_program("wl-copy", env)
    {
        return Some(Helper {
            program,
            args: vec!["--type".into(), mime_type.into()],
            stdin_from_file: true,
        });
    }
    if present("DISPLAY")
        && let Some(program) = find_program("xclip", env)
    {
        return Some(Helper {
            program,
            args: vec![
                "-selection".into(),
                "clipboard".into(),
                "-t".into(),
                mime_type.into(),
                "-i".into(),
                path.as_os_str().to_owned(),
            ],
            stdin_from_file: false,
        });
    }
    None
}

#[cfg(target_os = "macos")]
fn helper_for(
    path: &Path,
    mime_type: &str,
    env: &dyn Fn(&str) -> Option<OsString>,
) -> Option<Helper> {
    let class = match mime_type {
        "image/png" => "«class PNGf»",
        "image/jpeg" => "«class JPEG»",
        "image/gif" => "«class GIFf»",
        _ => return None,
    };
    let program = find_program("osascript", env)?;
    let script = format!(
        "on run argv\nset the clipboard to (read (POSIX file (item 1 of argv)) as {class})\nend run"
    );
    Some(Helper {
        program,
        args: vec!["-e".into(), script.into(), path.as_os_str().to_owned()],
        stdin_from_file: false,
    })
}

#[cfg(windows)]
fn helper_for(
    _path: &Path,
    _mime_type: &str,
    _env: &dyn Fn(&str) -> Option<OsString>,
) -> Option<Helper> {
    None
}

fn find_program(name: &str, env: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let paths = env("PATH")?;
    std::env::split_paths(&paths)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

/// Copies an image to the clipboard when a helper and a graphical session are available.
pub fn set_image_clipboard(path: &Path, mime_type: &str) -> ClipboardOutcome {
    let env = |name: &str| std::env::var_os(name);
    match helper_for(path, mime_type, &env) {
        Some(helper) => run_helper(helper, path),
        None => ClipboardOutcome::Unavailable,
    }
}

fn run_helper(helper: Helper, path: &Path) -> ClipboardOutcome {
    let stdin = if helper.stdin_from_file {
        match File::open(path) {
            Ok(file) => Stdio::from(file),
            Err(_) => return ClipboardOutcome::Unavailable,
        }
    } else {
        Stdio::null()
    };
    let mut command = Command::new(&helper.program);
    command
        .args(&helper.args)
        .stdin(stdin)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = match crate::spawn_gate::lock() {
        Ok(_gate) => command.spawn(),
        Err(error) => Err(error),
    };
    match child {
        Ok(child) => wait_bounded(child),
        Err(_) => ClipboardOutcome::Unavailable,
    }
}

/// Waits briefly; a helper that keeps running is owned by a reaper that kills it at a deadline.
fn wait_bounded(mut child: Child) -> ClipboardOutcome {
    let started = Instant::now();
    while started.elapsed() < SYNC_WAIT {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return ClipboardOutcome::Set,
            Ok(Some(_)) | Err(_) => return ClipboardOutcome::Unavailable,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    let reaper = std::thread::Builder::new()
        .name("paste-clipboard-reaper".to_owned())
        // The thread's result only records whether the helper was reaped; nothing waits on it.
        .spawn(move || reap(child).is_ok());
    match reaper {
        // Still serving the selection (foreground helpers); treat as set.
        Ok(_detached) => ClipboardOutcome::Set,
        Err(_) => ClipboardOutcome::Unavailable,
    }
}

fn reap(mut child: Child) -> std::io::Result<()> {
    let started = Instant::now();
    while started.elapsed() < REAPER_DEADLINE {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    child.kill()?;
    child.wait().map(|_status| ())
}

#[cfg(all(test, unix, not(target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn headless_hosts_have_no_clipboard_helper() {
        let env = |name: &str| (name == "PATH").then(|| OsString::from("/usr/bin:/bin"));
        assert!(helper_for(Path::new("/tmp/x.png"), "image/png", &env).is_none());
    }
}
