//! `bigbud-mobile-gateway` executable: configuration, startup and shutdown only.

use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::thread;

use bigbud_mobile_gateway::Gateway;
use bigbud_mobile_gateway::cli::{ParsedArgs, USAGE, parse_args};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let credential = std::env::var(bigbud_mobile_gateway::cli::CREDENTIAL_ENV).ok();
    let ParsedArgs {
        config,
        stdin_lifeline,
    } = match parse_args(&args, credential) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("bigbud-mobile-gateway: {error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let gateway = match Gateway::bind(config) {
        Ok(gateway) => gateway,
        Err(error) => {
            eprintln!("bigbud-mobile-gateway: {error}");
            return ExitCode::from(1);
        }
    };
    let shutdown = gateway.shutdown_handle();
    let address = match gateway.local_addr() {
        Ok(address) => address,
        Err(error) => {
            eprintln!("bigbud-mobile-gateway: {error}");
            return ExitCode::from(1);
        }
    };
    if stdin_lifeline {
        // The supervisor holds our stdin; EOF means it is gone, so stop.
        let spawned = thread::Builder::new()
            .name("mobile-gateway-lifeline".into())
            .spawn(move || {
                let stdin = std::io::stdin();
                for line in stdin.lock().lines() {
                    if line.is_err() {
                        break;
                    }
                }
                shutdown.shutdown();
            });
        if let Err(error) = spawned {
            eprintln!("bigbud-mobile-gateway: lifeline: {error}");
            return ExitCode::from(1);
        }
    }
    // Readiness line for the supervisor; supports `--listen 127.0.0.1:0`.
    let mut stdout = std::io::stdout();
    if writeln!(stdout, "{{\"event\":\"ready\",\"listen\":\"{address}\"}}")
        .and_then(|()| stdout.flush())
        .is_err()
    {
        return ExitCode::from(1);
    }
    match gateway.run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("bigbud-mobile-gateway: {error}");
            ExitCode::from(1)
        }
    }
}
