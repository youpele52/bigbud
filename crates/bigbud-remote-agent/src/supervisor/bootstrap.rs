use super::{
    AgentSession, Shared, admission, host_runtime::HostRuntime, io_helpers::broadcast_response,
    job_lifecycle, policy_loop, policy_loop::SupervisorOptions, serve_connection, signals,
};
use crate::workspace_watch_event_frame;
use bigbud_workspace_watch::WorkspaceWatchRegistry;
use std::collections::HashMap;
use std::io;
use std::os::unix::{fs::PermissionsExt, net::UnixListener};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub fn run_supervisor(session: AgentSession, socket_path: &Path) -> io::Result<()> {
    run_supervisor_with(session, socket_path, SupervisorOptions::default())
}

/// Runs the supervisor. A session with terminal lifecycle enabled also gets the host runtime:
/// connected owners, the snapshot worker and the policy loop (plan R5).
pub fn run_supervisor_with(
    session: AgentSession,
    socket_path: &Path,
    options: SupervisorOptions,
) -> io::Result<()> {
    let _cleanup = crate::pty::CleanupOwner::start()?;
    let runtime = session
        .terminal_host()
        .map(HostRuntime::start)
        .transpose()?;
    let listener = UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o700))?;
    let bound = signals::BoundSocket::capture(socket_path)?;
    let sessions = Arc::new(Mutex::new(session));
    // Installed before any connection can spawn a PTY child.
    signals::spawn(signals::install()?, Arc::clone(&sessions), bound)?;
    if let Some(runtime) = &runtime {
        policy_loop::spawn(Arc::clone(&sessions), Arc::clone(runtime), options)?;
    }
    let subscribers = Arc::new(Mutex::new(HashMap::new()));
    let watch_subscribers = Arc::new(Mutex::new(HashMap::new()));
    let watch_sink = Arc::clone(&watch_subscribers);
    let watchers = Arc::new(WorkspaceWatchRegistry::new(move |event| {
        let Some(_publication) = job_lifecycle::Completion::publication() else {
            return;
        };
        let subscription_id = event.subscription_id.clone();
        let _ = broadcast_response(
            &watch_sink,
            &subscription_id,
            workspace_watch_event_frame(event),
        );
    }));
    for stream in listener.incoming() {
        let stream = stream?;
        let (writer, handshake) = match admission::admit(&stream) {
            Ok(admitted) => admitted,
            Err(error) => {
                eprintln!("bigbud remote agent connection admission refused: {error}");
                continue;
            }
        };
        let shared = Shared {
            sessions: Arc::clone(&sessions),
            subscribers: Arc::clone(&subscribers),
            watch_subscribers: Arc::clone(&watch_subscribers),
            watchers: Arc::clone(&watchers),
            runtime: runtime.clone(),
        };
        std::thread::spawn(move || {
            if let Err(error) = serve_connection(stream, shared, writer, handshake) {
                eprintln!("bigbud remote agent supervisor connection ended: {error}");
            }
        });
    }
    Ok(())
}
