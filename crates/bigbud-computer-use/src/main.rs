use bigbud_computer_use::Role;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let role = args.first().and_then(|value| Role::parse(value));
    match role {
        // Local development only: elect/recover/guard-service lifecycle with
        // control frames on stdin/stdout (stdin EOF is the lifeline). Never
        // starts an owner or worker, never opens admission.
        #[cfg(all(target_os = "macos", debug_assertions))]
        Some(Role::Guard) => {
            bigbud_computer_use::roles::guard::ignore_terminal_signals();
            return ExitCode::from(bigbud_computer_use::roles::guard::run(
                args.get(1..).unwrap_or_default(),
                std::io::stdin(),
                std::io::stdout(),
            ));
        }
        Some(_) => eprintln!(
            "computer-use unavailable: supervised lifecycle/control implementation and platform qualification are incomplete"
        ),
        None => eprintln!("computer-use unavailable: expected guard, owner, worker or broker role"),
    }
    // Deliberately no native activation, legacy fallback or successful stub.
    ExitCode::FAILURE
}
