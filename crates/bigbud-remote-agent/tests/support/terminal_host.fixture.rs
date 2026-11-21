//! A real `--supervisor` terminal host and a framed client for the R5 integration tests.
//! Short `/tmp/bbth-*` roots keep socket paths inside `sockaddr_un`.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};
pub use v1::frame::Payload;

pub fn scratch() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = PathBuf::from(format!(
        "/tmp/bbth-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

pub struct Host {
    pub child: Child,
    pub state: PathBuf,
    pub socket: PathBuf,
}

impl Drop for Host {
    fn drop(&mut self) {
        let _killed = self.child.kill();
        let _status = self.child.wait();
    }
}

impl Host {
    pub fn start(state: &Path, flags: &[&str]) -> Self {
        Self::start_with_env(state, flags, &[])
    }

    pub fn start_with_env(state: &Path, flags: &[&str], env: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"));
        command
            .arg("--supervisor")
            .args(flags)
            .env("BIGBUD_AGENT_STATE_DIR", state)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(if std::env::var_os("BBTH_STDERR").is_some() {
                Stdio::inherit()
            } else {
                Stdio::null()
            });
        for (name, value) in env {
            command.env(name, value);
        }
        let child = command.spawn().unwrap();
        let socket = state.join("supervisor.sock");
        let deadline = Instant::now() + Duration::from_secs(15);
        while UnixStream::connect(&socket).is_err() {
            assert!(
                Instant::now() < deadline,
                "terminal host socket unavailable"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        Self {
            child,
            state: state.to_owned(),
            socket,
        }
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn rss_bytes(&self) -> u64 {
        let output = Command::new("ps")
            .args(["-o", "rss=", "-p", &self.pid().to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .unwrap_or(0)
            * 1024
    }
}

pub struct Client {
    writer: UnixStream,
    frames: Receiver<v1::Frame>,
    /// Frames received but not yet claimed by a `wait_for`.
    pub backlog: VecDeque<v1::Frame>,
    pub hello: v1::AgentHello,
    next_request: u64,
}

impl Client {
    pub fn connect(host: &Host, name: &str) -> Self {
        Self::connect_with_minor(host, name, PROTOCOL_MINOR)
    }

    /// `protocol_minor` below 9 is a client that predates the lifecycle frames.
    pub fn connect_with_minor(host: &Host, name: &str, protocol_minor: u32) -> Self {
        let stream = UnixStream::connect(&host.socket).unwrap();
        let mut reader = stream.try_clone().unwrap();
        let (sender, frames) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(Some(frame)) = read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES) {
                if sender.send(frame).is_err() {
                    return;
                }
            }
        });
        let mut client = Self {
            writer: stream,
            frames,
            backlog: VecDeque::new(),
            hello: v1::AgentHello::default(),
            next_request: 0,
        };
        client.send(Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor,
            client_instance_id: format!("client-{name}"),
            connection_id: format!("connection-{name}"),
            server_nonce: "nonce".to_owned(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }));
        client.hello = match client.wait_for(|p| matches!(p, Payload::AgentHello(_))) {
            Payload::AgentHello(hello) => hello,
            _ => unreachable_payload(),
        };
        client
    }

    pub fn send(&mut self, payload: Payload) {
        let frame = v1::Frame {
            payload: Some(payload),
        };
        write_frame(&mut self.writer, &frame, DEFAULT_MAX_FRAME_BYTES).unwrap();
    }

    pub fn request_id(&mut self, prefix: &str) -> String {
        self.next_request += 1;
        format!("{prefix}-{}", self.next_request)
    }

    /// Next frame from the socket (not the backlog), or `None` after `timeout`.
    pub fn recv(&mut self, timeout: Duration) -> Option<v1::Frame> {
        match self.frames.recv_timeout(timeout) {
            Ok(frame) => Some(frame),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => panic!("terminal host connection closed"),
        }
    }

    pub fn wait_for(&mut self, mut wanted: impl FnMut(&Payload) -> bool) -> Payload {
        if let Some(index) = self
            .backlog
            .iter()
            .position(|frame| frame.payload.as_ref().is_some_and(&mut wanted))
        {
            return self.backlog.remove(index).and_then(|f| f.payload).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "expected frame never arrived");
            let Some(frame) = self.recv(remaining) else {
                continue;
            };
            if frame.payload.as_ref().is_some_and(&mut wanted) {
                return frame.payload.unwrap();
            }
            if let Some(Payload::ProtocolError(error)) = &frame.payload {
                panic!("protocol error: {error:?}");
            }
            self.backlog.push_back(frame);
        }
    }

    pub fn open_workspace(&mut self, handle: &str, root: &Path) {
        let request_id = self.request_id("open");
        self.send(Payload::WorkspaceOpenRequest(v1::WorkspaceOpenRequest {
            request_id: request_id.clone(),
            workspace_handle: handle.to_owned(),
            root: root.to_string_lossy().into_owned(),
        }));
        match self.wait_for(
            |p| matches!(p, Payload::WorkspaceOpenResponse(r) if r.request_id == request_id),
        ) {
            Payload::WorkspaceOpenResponse(response) => assert!(response.accepted, "{response:?}"),
            _ => unreachable_payload(),
        }
    }

    pub fn create(&mut self, request: v1::PtyCreateRequest) -> v1::PtyCreateResponse {
        let request_id = request.request_id.clone();
        self.send(Payload::PtyCreateRequest(request));
        match self
            .wait_for(|p| matches!(p, Payload::PtyCreateResponse(r) if r.request_id == request_id))
        {
            Payload::PtyCreateResponse(response) => response,
            _ => unreachable_payload(),
        }
    }

    /// Sends a snapshot request and returns `(header, reassembled ANSI)`.
    pub fn snapshot(&mut self, pty_id: &str) -> (v1::PtyScreenSnapshotHeader, Vec<u8>) {
        let request_id = self.request_id("snap");
        self.send(snapshot_request(&request_id, pty_id));
        let header = match self.wait_for(
            |p| matches!(p, Payload::PtyScreenSnapshotHeader(h) if h.request_id == request_id),
        ) {
            Payload::PtyScreenSnapshotHeader(header) => *header,
            _ => unreachable_payload(),
        };
        let mut ansi = Vec::new();
        for index in 0..header.chunk_count {
            match self.wait_for(
                |p| matches!(p, Payload::PtyScreenSnapshotChunk(c) if c.request_id == request_id),
            ) {
                Payload::PtyScreenSnapshotChunk(chunk) => {
                    assert_eq!(chunk.index, index);
                    ansi.extend_from_slice(&chunk.bytes);
                }
                _ => unreachable_payload(),
            }
        }
        (header, ansi)
    }
}

pub fn snapshot_request(request_id: &str, pty_id: &str) -> Payload {
    Payload::PtyScreenSnapshotRequest(v1::PtyScreenSnapshotRequest {
        request_id: request_id.to_owned(),
        pty_id: pty_id.to_owned(),
        ..Default::default()
    })
}

pub fn create_request(pty_id: &str, shell: &str, args: &[&str]) -> v1::PtyCreateRequest {
    v1::PtyCreateRequest {
        request_id: format!("create-{pty_id}"),
        pty_id: pty_id.to_owned(),
        request_digest: pty_id.as_bytes().to_vec(),
        workspace_handle: "workspace".to_owned(),
        shell: shell.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        cols: 200,
        rows: 50,
        lifecycle_managed: true,
        spool: true,
        ..Default::default()
    }
}

fn unreachable_payload() -> ! {
    panic!("wait_for returned a payload its predicate rejected")
}

/// Writes `rows` lines of `cols` cells that each change colour, so a snapshot of the screen
/// is large (about 12 bytes per cell) but stays ASCII.
pub fn colourful_file(path: &Path, rows: usize, cols: usize) {
    let mut text = String::with_capacity(rows * cols * 12);
    for row in 0..rows {
        for col in 0..cols {
            let colour = (row * 7 + col * 13) % 216 + 16;
            let glyph = char::from(b'a' + ((row + col) % 26) as u8);
            text.push_str(&format!("\x1b[38;5;{colour}m{glyph}"));
        }
        text.push_str("\x1b[0m\r\n");
    }
    std::fs::write(path, text).unwrap();
}

pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).to_vec()
}
