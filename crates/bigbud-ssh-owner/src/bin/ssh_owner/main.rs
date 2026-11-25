// Proof-gated bootstrap on inherited stdio, with opt-in Unix reattachment.

#[cfg(unix)]
mod config;
#[cfg(unix)]
#[path = "main.run.rs"]
mod main_run;
#[cfg(unix)]
mod openssh_image;
#[cfg(unix)]
mod owner;
#[cfg(unix)]
mod owner_agent_proxy;
#[cfg(unix)]
mod owner_attachment;
#[cfg(any(unix, windows))]
mod owner_grants;
#[cfg(target_os = "linux")]
mod owner_opencode;
#[cfg(target_os = "linux")]
mod owner_opencode_v1;
#[cfg(target_os = "linux")]
mod owner_opencode_v2;
#[cfg(any(unix, windows))]
mod owner_pipe;
#[cfg(any(unix, windows))]
mod owner_storage;
#[cfg(unix)]
mod owner_terminal;
#[cfg(any(unix, windows))]
mod owner_trust;
#[cfg(unix)]
mod startup_bindings;
#[cfg(unix)]
mod startup_production;
#[cfg(unix)]
mod startup_profile;
#[cfg(unix)]
mod startup_route;
#[cfg(unix)]
mod transport;
#[cfg(target_os = "linux")]
use owner_agent_proxy::ProviderServiceKind;
#[cfg(unix)]
use startup_bindings::{ProofBindings, trailing_args};
#[cfg(windows)]
mod windows_bootstrap;
#[cfg(windows)]
mod windows_dispatcher;
#[cfg(any(windows, all(test, unix)))]
mod windows_picker;
#[cfg(windows)]
mod windows_transport;

#[cfg(any(unix, windows))]
mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.ssh_owner.v1.rs"));
}

#[cfg(unix)]
use std::{
    env,
    fs::File,
    io::{self, Read},
    process::ExitCode,
};

#[cfg(any(unix, windows))]
type RunResult<T> = Result<T, Box<dyn std::error::Error>>;
#[cfg(any(unix, windows))]
type Token = [u8; 32];
#[cfg(windows)]
use windows_bootstrap::random_token;

#[cfg(unix)]
fn random_token() -> io::Result<Token> {
    let mut token = [0; 32];
    File::open("/dev/urandom")?.read_exact(&mut token)?;
    Ok(token)
}

#[cfg(any(unix, windows))]
fn invalid_input() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "invalid picker fixture arguments",
    )
}

#[cfg(any(unix, windows))]
fn profile_binding(hex: &str) -> RunResult<Vec<u8>> {
    if hex.is_empty() || hex.len() > 256 || !hex.len().is_multiple_of(2) || !hex.is_ascii() {
        return Err(invalid_input().into());
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| Ok(u8::from_str_radix(std::str::from_utf8(pair)?, 16)?))
        .collect()
}

#[cfg(all(test, unix))]
#[path = "main_terminal_binding_tests.rs"]
mod terminal_binding_tests;

#[cfg(all(test, unix))]
#[path = "production_tests.rs"]
mod production_tests;

#[cfg(unix)]
fn run() -> RunResult<()> {
    let mut args = env::args_os().skip(1).peekable();
    if args.peek().and_then(|argument| argument.to_str()) == Some("--production") {
        args.next();
        return startup_production::run(args);
    }
    // Fixture and dev modes keep their unchanged proof gate and argument order.
    main_run::run(args)
}

#[cfg(unix)]
fn main() -> ExitCode {
    #[cfg(target_os = "linux")]
    if let Some(result) = transport::posix_master::maybe_run_password_helper() {
        return result;
    }
    #[cfg(target_os = "linux")]
    if let Some(result) = transport::posix_master::maybe_observe_key() {
        return result;
    }
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let Some(result) = owner::retirement::maybe_run_recovery(&args) {
        return match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => {
                eprintln!("retirement recovery refused or failed");
                ExitCode::FAILURE
            }
        };
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            // Do not echo frame content, tokens, or fixture paths.
            eprintln!("S1 picker proof owner stopped");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    use std::process::ExitCode;

    let mut args = std::env::args_os().skip(1);
    let mode = args.next();
    let result = match mode.as_deref().and_then(std::ffi::OsStr::to_str) {
        Some("--windows-picker-dispatcher") => windows_dispatcher::run(args),
        mode => windows_bootstrap::run(mode, args),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            // Never print the bootstrap record or endpoint identifiers.
            eprintln!("Windows picker proof owner stopped");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn main() -> std::process::ExitCode {
    eprintln!("S1 picker proof owner unavailable on this platform");
    std::process::ExitCode::FAILURE
}
