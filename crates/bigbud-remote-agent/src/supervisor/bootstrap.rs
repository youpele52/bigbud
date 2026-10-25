use super::{
    AgentSession, admission, io_helpers::broadcast_response, job_lifecycle, serve_connection,
};
use crate::workspace_watch_event_frame;
use bigbud_workspace_watch::WorkspaceWatchRegistry;
use std::collections::HashMap;
use std::io;
use std::os::unix::{fs::PermissionsExt, net::UnixListener};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub fn run_supervisor(session: AgentSession, socket_path: &Path) -> io::Result<()> {
    let _cleanup = crate::pty::CleanupOwner::start()?;
    let listener = UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o700))?;
    let sessions = Arc::new(Mutex::new(session));
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
        let sessions = Arc::clone(&sessions);
        let subscribers = Arc::clone(&subscribers);
        let watch_subscribers = Arc::clone(&watch_subscribers);
        let watchers = Arc::clone(&watchers);
        std::thread::spawn(move || {
            if let Err(error) = serve_connection(
                stream,
                sessions,
                subscribers,
                watch_subscribers,
                watchers,
                writer,
                handshake,
            ) {
                eprintln!("bigbud remote agent supervisor connection ended: {error}");
            }
        });
    }
    Ok(())
}
