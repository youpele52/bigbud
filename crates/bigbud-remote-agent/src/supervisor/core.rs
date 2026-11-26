use super::shutdown_response;
use crate::AgentSession;
use bigbud_protocol::v1;
use bigbud_workspace_watch::WorkspaceWatchRegistry;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
#[cfg(unix)]
pub(super) type Writer = Arc<writer::OutboundWriter>;
#[cfg(unix)]
#[path = "writer.rs"]
mod writer;
#[cfg(unix)]
pub(super) type Subscribers = Arc<Mutex<HashMap<String, Vec<Arc<subscription::Subscription>>>>>;
#[cfg(unix)]
#[path = "admission.rs"]
mod admission;
#[cfg(unix)]
#[path = "attach.rs"]
mod attach;
#[cfg(unix)]
#[path = "detach.rs"]
mod detach;
#[cfg(unix)]
#[path = "drain.rs"]
mod drain;
#[cfg(unix)]
#[path = "frame_reader.rs"]
mod frame_reader;
#[cfg(unix)]
#[path = "io.rs"]
mod io_helpers;
#[cfg(unix)]
#[path = "jobs.lifecycle.rs"]
mod job_lifecycle;
#[cfg(unix)]
#[path = "jobs.rs"]
mod jobs;
#[cfg(unix)]
#[path = "search.rs"]
mod search;
#[cfg(unix)]
#[path = "signals.rs"]
mod signals;
#[cfg(unix)]
#[path = "subscription.rs"]
mod subscription;
#[cfg(unix)]
use io_helpers::*;
#[cfg(unix)]
use jobs::{spawn_process_job, spawn_pty_job};
#[cfg(unix)]
#[path = "bootstrap.rs"]
mod bootstrap;
#[cfg(unix)]
#[path = "connection.rs"]
mod connection;
#[cfg(unix)]
#[path = "connection.lifecycle.rs"]
mod connection_lifecycle;
#[cfg(unix)]
#[path = "daemonize.rs"]
pub(super) mod daemonize;
#[cfg(unix)]
#[path = "host_runtime.rs"]
mod host_runtime;
#[cfg(unix)]
#[path = "policy_loop.rs"]
mod policy_loop;
#[cfg(unix)]
#[path = "snapshot_worker.rs"]
mod snapshot_worker;
#[cfg(all(test, unix))]
#[path = "test_hooks.rs"]
mod test_hooks;
#[cfg(unix)]
pub use bootstrap::{run_supervisor, run_supervisor_with};
#[cfg(unix)]
pub use policy_loop::SupervisorOptions;
#[cfg(not(unix))]
pub fn run_supervisor(_session: AgentSession, _socket_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "the remote agent supervisor requires Unix-domain sockets on this platform",
    ))
}
/// Shared supervisor state handed to every connection.
#[cfg(unix)]
#[derive(Clone)]
struct Shared {
    sessions: Arc<Mutex<AgentSession>>,
    subscribers: Subscribers,
    watch_subscribers: Subscribers,
    watchers: Arc<WorkspaceWatchRegistry>,
    /// The terminal-host runtime; `None` keeps a session without lifecycle exactly as before.
    runtime: Option<Arc<host_runtime::HostRuntime>>,
}

#[cfg(unix)]
fn serve_connection(
    stream: UnixStream,
    shared: Shared,
    writer: Writer,
    handshake: frame_reader::HandshakePermit,
) -> io::Result<()> {
    let Shared {
        sessions,
        subscribers,
        watch_subscribers,
        watchers,
        runtime,
    } = shared;
    let mut subscriptions = HashSet::new();
    let mut searches = search::workers(&sessions)?;
    let result = connection::serve_connection_loop(
        stream,
        sessions,
        Arc::clone(&subscribers),
        &watch_subscribers,
        &watchers,
        &mut subscriptions,
        (
            Arc::clone(&writer),
            handshake,
            &mut searches,
            runtime.as_ref(),
        ),
    );
    if let Some(runtime) = &runtime {
        runtime.remove_owner(&writer);
    }
    searches.cancel_and_join();
    for subscription_id in subscriptions {
        watchers.unsubscribe(&subscription_id);
        remove_all_subscribers(&watch_subscribers, &subscription_id);
    }
    remove_connection(&subscribers, &writer)?;
    remove_connection(&watch_subscribers, &writer)?;
    let drain = if result.is_ok() {
        writer.drain()
    } else {
        Ok(())
    };
    writer.join()?;
    result.and(drain)
}

#[path = "proxy.rs"]
mod proxy;
#[cfg(target_os = "linux")]
pub(crate) use proxy::forward_authenticated_proxy;

pub use proxy::run_proxy;

#[path = "prepare.rs"]
mod prepare;

pub use prepare::{SupervisorPreparation, prepare_supervisor};

#[cfg(all(test, unix))]
#[path = "reliability.tests.rs"]
mod reliability_tests;
