use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use notify::{Config, Event, PollWatcher, RecommendedWatcher, Watcher};

use crate::manager::ManagerCommand;
use crate::{WorkspaceWatchBackend, WorkspaceWatchHost};

const POLL_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) trait WatchBackendFactory: Send + Sync {
    fn create(
        &self,
        workspace: &dyn WorkspaceWatchHost,
        sender: mpsc::SyncSender<ManagerCommand>,
    ) -> notify::Result<WatchBackend>;

    fn poll(&self, sender: mpsc::SyncSender<ManagerCommand>) -> notify::Result<WatchBackend>;
}

pub(crate) struct SystemWatchBackendFactory;

impl WatchBackendFactory for SystemWatchBackendFactory {
    fn create(
        &self,
        workspace: &dyn WorkspaceWatchHost,
        sender: mpsc::SyncSender<ManagerCommand>,
    ) -> notify::Result<WatchBackend> {
        WatchBackend::new(workspace, sender)
    }

    fn poll(&self, sender: mpsc::SyncSender<ManagerCommand>) -> notify::Result<WatchBackend> {
        WatchBackend::poll(sender)
    }
}

pub(crate) struct WatchBackend {
    watcher: Box<dyn Watcher + Send>,
    kind: WorkspaceWatchBackend,
    sender: mpsc::SyncSender<ManagerCommand>,
    allow_poll_fallback: bool,
}

impl WatchBackend {
    pub(crate) fn new(
        workspace: &dyn WorkspaceWatchHost,
        sender: mpsc::SyncSender<ManagerCommand>,
    ) -> notify::Result<Self> {
        let mode = watcher_mode(workspace.canonical_root());
        if mode != "poll" {
            match RecommendedWatcher::new(event_handler(sender.clone()), Config::default()) {
                Ok(watcher) => {
                    return Ok(Self {
                        watcher: Box::new(watcher),
                        kind: WorkspaceWatchBackend::Native,
                        sender,
                        allow_poll_fallback: mode != "native-only",
                    });
                }
                Err(error) if mode == "native-only" => return Err(error),
                Err(_) => {}
            }
        }
        Self::poll(sender)
    }

    pub(crate) fn poll(sender: mpsc::SyncSender<ManagerCommand>) -> notify::Result<Self> {
        let watcher = PollWatcher::new(
            event_handler(sender.clone()),
            Config::default()
                .with_poll_interval(POLL_INTERVAL)
                .with_compare_contents(true),
        )?;
        Ok(Self {
            watcher: Box::new(watcher),
            kind: WorkspaceWatchBackend::Poll,
            sender,
            allow_poll_fallback: true,
        })
    }

    pub(crate) fn kind(&self) -> WorkspaceWatchBackend {
        self.kind
    }

    pub(crate) fn watch(&mut self, path: &Path, existing_paths: &[&Path]) -> notify::Result<bool> {
        match self
            .watcher
            .watch(path, notify::RecursiveMode::NonRecursive)
        {
            Ok(()) => Ok(false),
            Err(_) if self.kind == WorkspaceWatchBackend::Native && self.allow_poll_fallback => {
                let mut poll = Self::poll(self.sender.clone())?;
                for existing in existing_paths.iter().copied().collect::<HashSet<_>>() {
                    poll.watcher
                        .watch(existing, notify::RecursiveMode::NonRecursive)?;
                }
                poll.watcher
                    .watch(path, notify::RecursiveMode::NonRecursive)?;
                *self = poll;
                Ok(true)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        self.watcher.unwatch(path)
    }

    #[cfg(test)]
    pub(crate) fn injected(
        watcher: Box<dyn Watcher + Send>,
        kind: WorkspaceWatchBackend,
        sender: mpsc::SyncSender<ManagerCommand>,
        allow_poll_fallback: bool,
    ) -> Self {
        Self {
            watcher,
            kind,
            sender,
            allow_poll_fallback,
        }
    }
}

fn event_handler(
    sender: mpsc::SyncSender<ManagerCommand>,
) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |event| {
        if let Err(mpsc::TrySendError::Full(_)) = sender.try_send(ManagerCommand::FileSystem(event))
        {
            let _ = sender.send(ManagerCommand::Overflow);
        }
    }
}

fn watcher_mode(root: &Path) -> &'static str {
    let configured = std::env::var("BIGBUD_WORKSPACE_WATCHER_MODE")
        .or_else(|_| std::env::var("BIGBUD_REMOTE_FILE_WATCHER_MODE"));
    match configured.as_deref() {
        Ok("poll") => "poll",
        Ok("native") => "native-only",
        _ if is_network_filesystem(root) => "poll",
        _ => "native",
    }
}

#[cfg(target_os = "linux")]
fn is_network_filesystem(root: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let Ok(path) = CString::new(root.as_os_str().as_bytes()) else {
        return true;
    };
    let mut metadata = unsafe { std::mem::zeroed::<libc::statfs>() };
    if unsafe { libc::statfs(path.as_ptr(), &mut metadata) } != 0 {
        return true;
    }
    matches!(
        metadata.f_type as u64,
        0x6969 | 0x517b | 0xff534d42 | 0xfe534d42 | 0x65735546 | 0x01021997
    )
}

#[cfg(target_os = "macos")]
fn is_network_filesystem(root: &Path) -> bool {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;

    let Ok(path) = CString::new(root.as_os_str().as_bytes()) else {
        return true;
    };
    let mut metadata = unsafe { std::mem::zeroed::<libc::statfs>() };
    if unsafe { libc::statfs(path.as_ptr(), &mut metadata) } != 0 {
        return true;
    }
    let filesystem = unsafe { CStr::from_ptr(metadata.f_fstypename.as_ptr()) }
        .to_string_lossy()
        .to_ascii_lowercase();
    matches!(
        filesystem.as_str(),
        "nfs" | "smbfs" | "webdav" | "osxfuse" | "macfuse"
    )
}

#[cfg(target_os = "windows")]
fn is_network_filesystem(root: &Path) -> bool {
    root.to_string_lossy().starts_with(r"\\")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn is_network_filesystem(_root: &Path) -> bool {
    false
}
