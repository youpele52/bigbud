//! An in-process terminal host for lifecycle tests: a session with lifecycle enabled, a fake
//! clock, captured unsolicited frames, and PTY reader threads that drive output exactly like
//! the supervisor's job (`supervisor/jobs.rs`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::super::*;
use crate::terminal_policy::FakeClock;

pub(crate) struct Host {
    pub session: Arc<Mutex<AgentSession>>,
    pub host: Arc<HostLifecycle>,
    pub clock: FakeClock,
    pub frames: Arc<Mutex<Vec<v1::Frame>>>,
    pub root: PathBuf,
    /// PTY ids are process-wide (cleanup reservations), so each host tags its own.
    tag: String,
    readers: Vec<std::thread::JoinHandle<()>>,
}

pub(crate) fn scratch(prefix: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = PathBuf::from(format!(
        "/tmp/{prefix}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    // The spool refuses state folders other users can read.
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    path
}

pub(crate) fn open_request(handle: &str, root: &Path) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
            v1::WorkspaceOpenRequest {
                request_id: format!("open-{handle}"),
                workspace_handle: handle.to_owned(),
                root: root.to_string_lossy().into_owned(),
            },
        )),
    }
}

impl Host {
    pub fn new(local_desktop_host: bool) -> Self {
        let root = scratch("bbr5");
        let clock = FakeClock::new(1_000_000);
        let mut session = AgentSession::new().unwrap();
        let host = session.enable_terminal_host(
            Some(&root.join("state")),
            HostOptions {
                local_desktop_host,
                clock: Arc::new(clock.clone()),
                ..HostOptions::default()
            },
        );
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&frames);
        host.set_sink(Arc::new(move |frame: &v1::Frame| {
            sink.lock().unwrap().push(frame.clone());
        }));
        session.handle(super::super::test_helpers::hello()).unwrap();
        std::fs::create_dir_all(root.join("ws")).unwrap();
        session
            .handle(open_request("workspace", &root.join("ws")))
            .unwrap();
        let tag = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self {
            session: Arc::new(Mutex::new(session)),
            host,
            clock,
            frames,
            root,
            tag,
            readers: Vec::new(),
        }
    }

    /// The process-unique PTY id for a test-local name.
    pub fn id(&self, name: &str) -> String {
        format!("{}-{name}", self.tag)
    }

    fn name(&self, id: &str) -> String {
        id.strip_prefix(&format!("{}-", self.tag))
            .unwrap_or(id)
            .to_owned()
    }

    pub fn request(
        &self,
        id: &str,
        managed: bool,
        shell: &str,
        args: &[&str],
    ) -> v1::PtyCreateRequest {
        v1::PtyCreateRequest {
            request_id: format!("create-{id}"),
            pty_id: self.id(id),
            request_digest: id.as_bytes().to_vec(),
            workspace_handle: "workspace".to_owned(),
            shell: shell.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            cols: 80,
            rows: 24,
            lifecycle_managed: managed,
            // A 1.9 client: any lifecycle field gives the PTY lifecycle state.
            screen_scrollback_rows: 1000,
            ..Default::default()
        }
    }

    /// Creates a PTY and drives its output like the supervisor job does.
    pub fn create(&mut self, request: v1::PtyCreateRequest) -> v1::PtyCreateResponse {
        let (frame, job) = self
            .session
            .lock()
            .unwrap()
            .prepare_pty_create(request)
            .unwrap();
        if let Some(job) = job {
            self.drive(job);
        }
        match frame.payload {
            Some(v1::frame::Payload::PtyCreateResponse(response)) => response,
            other => panic!("unexpected create response {other:?}"),
        }
    }

    fn drive(&mut self, job: pty::PtyJob) {
        let sessions = Arc::clone(&self.session);
        self.readers.push(std::thread::spawn(move || {
            let pty_id = job.handle.id.clone();
            let lifecycle = sessions.lock().unwrap().pty_lifecycle(&pty_id).ok();
            pty::run_events(job.reader, &job.handle, |event| match event {
                pty::PtyEvent::Output(bytes) => {
                    let recorded = sessions.lock().unwrap().record_pty_output(&pty_id, bytes);
                    if let (Some(lifecycle), Ok((_frame, chunk))) = (&lifecycle, recorded) {
                        lifecycle.on_output(chunk.sequence, chunk.bytes);
                    }
                }
                pty::PtyEvent::Exited { exit_code, signal } => {
                    if let Some(lifecycle) = &lifecycle {
                        lifecycle.on_exit();
                    }
                    let _ = sessions
                        .lock()
                        .unwrap()
                        .complete_pty(&pty_id, exit_code, signal);
                }
            });
        }));
    }

    pub fn policy(&self, enabled: bool, max_live: u32, orphan_ms: u64) -> v1::HostPolicy {
        self.host.apply_policy(Some(&v1::HostPolicy {
            lifecycle_enabled: enabled,
            idle_close_ms: 60_000,
            idle_warning_ms: 30_000,
            max_live_ptys: max_live,
            orphan_close_ms: orphan_ms,
            revision: 1,
            ..Default::default()
        }))
    }

    /// One policy tick, with host-initiated closes noted like the supervisor loop does.
    pub fn tick(&self) -> Vec<String> {
        let ptys = self.session.lock().unwrap().lifecycle_ptys();
        let closed = self.host.run_policy(&ptys);
        let mut session = self.session.lock().unwrap();
        for id in &closed {
            session.note_pty_closed(id);
        }
        closed.iter().map(|id| self.name(id)).collect()
    }

    pub fn lifecycle(&self, id: &str) -> Arc<PtyLifecycle> {
        self.session
            .lock()
            .unwrap()
            .pty_lifecycle(&self.id(id))
            .ok()
            .unwrap()
    }

    /// `(pty_id, kind)` of every notice pushed so far.
    pub fn notices(&self) -> Vec<(String, String)> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|frame| match &frame.payload {
                Some(v1::frame::Payload::PtyLifecycleNotice(notice)) => {
                    Some((self.name(&notice.pty_id), notice.kind.clone()))
                }
                _ => None,
            })
            .collect()
    }

    /// Close notices follow the reap (R8), so they arrive shortly after the close.
    pub fn wait_notice(&self, id: &str, kind: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(6);
        while Instant::now() < deadline {
            if self.has_notice(id, kind) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    pub fn has_notice(&self, id: &str, kind: &str) -> bool {
        self.notices().iter().any(|(pty, k)| pty == id && k == kind)
    }

    /// Waits (real time) until the PTY printed something, so the shell is at its prompt.
    pub fn wait_output(&self, id: &str) {
        let handle = Arc::clone(self.lifecycle(id).handle());
        let deadline = Instant::now() + Duration::from_secs(10);
        while handle.snapshot().unwrap().next_sequence <= 1 {
            assert!(Instant::now() < deadline, "no output from {id}");
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    pub fn output_text(&self, id: &str) -> String {
        let handle = Arc::clone(self.lifecycle(id).handle());
        handle
            .replay(0)
            .unwrap()
            .into_iter()
            .flat_map(|chunk| chunk.bytes.to_vec())
            .map(char::from)
            .collect()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let handles = {
            let session = self.session.lock().unwrap_or_else(|e| e.into_inner());
            session
                .pty_sessions
                .values()
                .map(|session| Arc::clone(&session.handle))
                .collect::<Vec<_>>()
        };
        for handle in handles {
            let _ = handle.force_kill();
        }
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
