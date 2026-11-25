use super::*;
use std::ffi::OsString;

#[test]
fn dev_terminal_requires_the_explicit_flag_and_workspace_binding() {
    let parse = |args: &[&str]| trailing_args(args.iter().map(OsString::from));
    let legacy = parse(&["--workspace-root", "/workspace"]).expect("legacy binding");
    assert!(!legacy.dev_interactive_terminal);
    assert!(parse(&["--dev-interactive-terminal"]).is_err());
    let bound = parse(&[
        "--dev-interactive-terminal",
        "--workspace-root",
        "/workspace",
    ]);
    if cfg!(target_os = "macos") {
        assert!(
            bound
                .expect("explicit dev binding")
                .dev_interactive_terminal
        );
    } else {
        assert!(bound.is_err());
    }
    assert!(
        parse(&[
            "--workspace-root",
            "/workspace",
            "--dev-interactive-terminal",
            "--dev-interactive-terminal",
        ])
        .is_err()
    );
    assert!(
        parse(&[
            "--workspace-root",
            "/workspace",
            "--dev-interactive-terminal",
            "--command",
            "/bin/false",
        ])
        .is_err()
    );
}
