//! Standalone entry; not packaged or selected by product credential routing.

use std::process::ExitCode;

#[cfg(windows)]
fn main() -> ExitCode {
    use std::io::{self, Write};

    let mut args = std::env::args_os().skip(1);
    let Some(arg) = args.next() else {
        return ExitCode::FAILURE;
    };
    if args.next().is_some() {
        return ExitCode::FAILURE;
    }
    let result = if arg == "--metadata" {
        // Identity, not a native inbox/askpass qualification claim.
        io::stdout().lock().write_all(
            concat!(
                "{\"binary\":\"bigbud-ssh-password-helper\",\"version\":\"",
                env!("CARGO_PKG_VERSION"),
                "\",\"helperProtocol\":1,\"windowsPasswordSupported\":false}\n",
            )
            .as_bytes(),
        )
    } else {
        bigbud_ssh_owner::windows_password_gate::native::run_password_helper_prompt(&arg)
    };
    // No prompt, bootstrap metadata, native error or credential is logged.
    if result.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    ExitCode::FAILURE
}
