use std::collections::HashSet;
use std::io::{self, BufReader, BufWriter, Write};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, read_frame, write_frame};
use bigbud_remote_agent::{
    AgentSession, identity, protocol_error_frame,
    state::{AgentState, supervisor_socket_path},
    supervisor::{SupervisorPreparation, prepare_supervisor, run_proxy},
    workspace_watch_event_frame,
};
use bigbud_workspace_watch::WorkspaceWatchRegistry;

#[cfg(unix)]
use bigbud_remote_agent::supervisor::run_supervisor;

fn state_root() -> Option<std::path::PathBuf> {
    std::env::var_os("BIGBUD_AGENT_STATE_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| std::path::PathBuf::from(home).join(".bigbud/agent/state"))
        })
}

fn create_session() -> Result<AgentSession> {
    let state_root = state_root();
    match state_root {
        Some(root) => {
            let state = AgentState::open(&root)
                .with_context(|| format!("failed to open agent state at {}", root.display()))?;
            AgentSession::with_epoch_and_journal(
                state.epoch().to_owned(),
                state.operation_journal_path(),
            )
            .context("failed to restore the agent session journal")
        }
        None => AgentSession::new().context("failed to create an ephemeral agent session"),
    }
}

fn run_stdio(mut session: AgentSession) -> io::Result<()> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let writer = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let watch_writer = Arc::clone(&writer);
    let watchers = WorkspaceWatchRegistry::new(move |event| {
        let _ = write_stdio_responses(&watch_writer, vec![workspace_watch_event_frame(event)]);
    });
    let mut watch_subscriptions = HashSet::new();
    loop {
        let frame = match read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(error) => {
                eprintln!("bigbud remote agent protocol error: {error}");
                return Err(io::Error::new(io::ErrorKind::InvalidData, error));
            }
        };

        let responses = match frame.payload.clone() {
            Some(bigbud_protocol::v1::frame::Payload::WorkspaceWatchStartRequest(request)) => {
                session
                    .prepare_workspace_watch_start(request)
                    .map(|prepared| {
                        let response = prepared.register(&watchers);
                        if let Some(
                            bigbud_protocol::v1::frame::Payload::WorkspaceWatchStartResponse(
                                started,
                            ),
                        ) = &response.payload
                            && started.accepted
                        {
                            watch_subscriptions.insert(started.subscription_id.clone());
                        }
                        vec![response]
                    })
            }
            Some(bigbud_protocol::v1::frame::Payload::WorkspaceWatchStopRequest(request)) => {
                let subscription_id = request.subscription_id.clone();
                let stopped = watchers.unsubscribe(&subscription_id);
                watch_subscriptions.remove(&subscription_id);
                session
                    .workspace_watch_stop_response(request, stopped)
                    .map(|response| vec![response])
            }
            Some(bigbud_protocol::v1::frame::Payload::ProcessRequest(request)) => {
                session.handle_process_request(request)
            }
            Some(bigbud_protocol::v1::frame::Payload::ProcessAttachRequest(request)) => {
                session.handle_process_attach(request)
            }
            _ => session.handle(frame).map(|response| vec![response]),
        };
        match responses {
            Ok(responses) => {
                write_stdio_responses(&writer, responses)?;
            }
            Err(error) => {
                let response = protocol_error_frame(&error);
                write_stdio_responses(&writer, vec![response])?;
            }
        }
    }
}

fn write_stdio_responses(
    writer: &Arc<Mutex<BufWriter<io::Stdout>>>,
    responses: Vec<bigbud_protocol::v1::Frame>,
) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("agent writer lock was poisoned"))?;
    for response in responses {
        write_frame(&mut *writer, &response, DEFAULT_MAX_FRAME_BYTES)
            .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))?;
    }
    writer.flush()
}

fn run_check() {
    println!(
        "bigbud-remote-agent\t{}\t{}\t{}\t{}\t{}\t{}",
        identity::build_version(),
        bigbud_protocol::PROTOCOL_MAJOR,
        bigbud_protocol::PROTOCOL_MINOR,
        identity::build_digest(),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
}

#[cfg(unix)]
fn run_supervisor_mode(root: std::path::PathBuf) -> Result<()> {
    let state = AgentState::open_for_supervisor(&root)
        .with_context(|| format!("failed to open supervisor state at {}", root.display()))?;
    run_supervisor(
        AgentSession::with_epoch_and_journal(
            state.epoch().to_owned(),
            state.operation_journal_path(),
        )
        .context("failed to restore the supervisor session journal")?,
        &supervisor_socket_path(root),
    )
    .context("remote agent supervisor failed")
}

#[cfg(not(unix))]
fn run_supervisor_mode(_root: std::path::PathBuf) -> Result<()> {
    anyhow::bail!("the remote agent supervisor requires Unix-domain sockets on this platform")
}

fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("--check") => {
            run_check();
            Ok(())
        }
        Some("--supervisor") => {
            let root = state_root().context("HOME is required for supervisor mode")?;
            run_supervisor_mode(root)
        }
        Some("--prepare-supervisor") => {
            let root = state_root().context("HOME is required to prepare the supervisor")?;
            match prepare_supervisor(&supervisor_socket_path(root))
                .context("failed to prepare the remote agent supervisor")?
            {
                SupervisorPreparation::Ready => Ok(()),
                SupervisorPreparation::StartRequired => std::process::exit(10),
                SupervisorPreparation::BlockedActiveWork => {
                    eprintln!(
                        "remote agent upgrade is blocked by active terminals or process operations; close them and retry"
                    );
                    std::process::exit(11)
                }
            }
        }
        Some("--proxy") => {
            let root = state_root().context("HOME is required for proxy mode")?;
            let stdin = io::stdin();
            let stdout = io::stdout();
            run_proxy(stdin, stdout.lock(), &supervisor_socket_path(root))
                .context("remote agent proxy failed")
        }
        Some("--ephemeral") => {
            run_stdio(AgentSession::new().context("failed to create the ephemeral agent session")?)
                .context("remote agent stdio mode failed")
        }
        Some("--resource-cleanup") => bigbud_remote_agent::resource_cleanup::run_stdio()
            .context("resource cleanup stdio mode failed"),
        _ => run_stdio(create_session()?).context("remote agent stdio mode failed"),
    }
}
