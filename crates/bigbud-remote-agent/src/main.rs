use std::io::{self, BufReader, BufWriter};

use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, read_frame, write_frame};
use bigbud_remote_agent::{
    AgentSession, protocol_error_frame,
    state::{AgentState, supervisor_socket_path},
    supervisor::{run_proxy, run_supervisor},
};

fn state_root() -> Option<std::path::PathBuf> {
    std::env::var_os("BIGBUD_AGENT_STATE_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| std::path::PathBuf::from(home).join(".bigbud/agent/state"))
        })
}

fn create_session() -> io::Result<AgentSession> {
    let state_root = state_root();
    match state_root {
        Some(root) => {
            let state = AgentState::open(root)
                .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
            AgentSession::with_epoch_and_journal(
                state.epoch().to_owned(),
                state.operation_journal_path(),
            )
            .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))
        }
        None => Ok(AgentSession::new()),
    }
}

fn run_stdio(mut session: AgentSession) -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
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
                for response in responses {
                    write_frame(&mut writer, &response, DEFAULT_MAX_FRAME_BYTES)
                        .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))?;
                }
            }
            Err(error) => {
                let response = protocol_error_frame(&error);
                write_frame(&mut writer, &response, DEFAULT_MAX_FRAME_BYTES).map_err(
                    |write_error| io::Error::new(io::ErrorKind::BrokenPipe, write_error),
                )?;
            }
        }
    }
}

fn run_check() {
    let version = option_env!("BIGBUD_AGENT_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    println!(
        "bigbud-remote-agent\t{}\t{}\t{}\t{}",
        version,
        bigbud_protocol::PROTOCOL_MAJOR,
        bigbud_protocol::PROTOCOL_MINOR,
        option_env!("BIGBUD_AGENT_BUILD_DIGEST").unwrap_or(env!("CARGO_PKG_VERSION")),
    );
}

fn main() -> io::Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("--check") => {
            run_check();
            Ok(())
        }
        Some("--supervisor") => {
            let root = state_root().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "HOME is required for supervisor mode",
                )
            })?;
            let state = AgentState::open_for_supervisor(&root)
                .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
            run_supervisor(
                AgentSession::with_epoch_and_journal(
                    state.epoch().to_owned(),
                    state.operation_journal_path(),
                )
                .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?,
                &supervisor_socket_path(root),
            )
        }
        Some("--proxy") => {
            let root = state_root().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "HOME is required for proxy mode",
                )
            })?;
            let stdin = io::stdin();
            let stdout = io::stdout();
            run_proxy(stdin, stdout.lock(), &supervisor_socket_path(root))
        }
        _ => run_stdio(create_session()?),
    }
}
