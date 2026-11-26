use super::*;
use std::path::Path;

const BIN: &str = "/opt/bigbud/pi/bin/pi";
const ROOT: &str = "/tmp/bigbud-provider-workspace";
const SESSION: &str = "/tmp/bigbud-provider-workspace/.pi/session.jsonl";

fn scope() -> ProofProviderScope {
    ProofProviderScope {
        thread_id: "thread-1".into(),
        session_epoch: 4,
        cwd: ROOT.into(),
        binary: BIN.into(),
        session_file: None,
    }
}

fn recipe(kind: Kind) -> Recipe {
    Recipe::new(kind, Path::new(BIN), Path::new(ROOT)).expect("configured service")
}

#[test]
fn admits_only_the_configured_executable_workspace_and_session() {
    let pi = recipe(Kind::Pi);
    assert!(pi.matches(&scope()));
    for changed in [
        ProofProviderScope {
            binary: "/usr/bin/env".into(),
            ..scope()
        },
        ProofProviderScope {
            cwd: "/tmp/other-workspace".into(),
            ..scope()
        },
        ProofProviderScope {
            cwd: format!("{ROOT}/.."),
            ..scope()
        },
        ProofProviderScope {
            thread_id: String::new(),
            ..scope()
        },
    ] {
        assert!(!pi.matches(&changed), "{changed:?}");
    }
    let codex = recipe(Kind::Codex);
    assert!(codex.matches(&scope()));
    assert!(!codex.matches(&ProofProviderScope {
        binary: BIN.into(),
        cwd: "/".into(),
        thread_id: "thread-1".into(),
        session_epoch: 4,
        session_file: None,
    }));
}

#[test]
fn refuses_a_binding_without_an_exact_absolute_executable_and_root() {
    for (binary, root) in [
        ("relative/pi", ROOT),
        ("/opt/../pi", ROOT),
        ("/opt//pi", ROOT),
        (BIN, "/"),
        (BIN, "relative"),
        (BIN, "/tmp/../etc"),
        (BIN, ROOT),
    ] {
        let error = Recipe::new(Kind::Pi, Path::new(binary), Path::new(root)).err();
        if binary == BIN && root == ROOT {
            assert!(error.is_none(), "the configured pair is valid");
        } else {
            assert!(error.is_some(), "{binary} {root}");
        }
    }
}

#[test]
fn pi_resume_is_a_bounded_path_inside_the_authorized_workspace() {
    let pi = recipe(Kind::Pi);
    assert!(pi.matches(&ProofProviderScope {
        session_file: Some(SESSION.into()),
        ..scope()
    }));
    for file in [
        "/etc/passwd",
        "/tmp/bigbud-provider-workspace/../escape.jsonl",
        "/tmp/bigbud-provider-workspace/./inside.jsonl",
        "/tmp/bigbud-provider-workspace//inside.jsonl",
        "/tmp/bigbud-provider-workspace/",
        "/tmp/bigbud-provider-workspace",
        "/tmp/bigbud-provider-workspace/a\0b",
        "/tmp/bigbud-provider-workspace/a\nb",
        &format!("/tmp/bigbud-provider-workspace/{}", "a".repeat(4096)),
    ] {
        assert!(
            !pi.matches(&ProofProviderScope {
                session_file: Some(file.into()),
                ..scope()
            }),
            "{file}"
        );
    }
    // Codex never accepts a resume operand.
    assert!(!recipe(Kind::Codex).matches(&ProofProviderScope {
        session_file: Some(SESSION.into()),
        ..scope()
    }));
}

#[test]
fn one_owner_compiled_recipe_per_verb_with_no_forward_or_extra_options() {
    let pi = recipe(Kind::Pi);
    let probe = pi.probe_command();
    let start = pi.command(&scope());
    for command in [&probe, &start] {
        assert!(command.contains("/bin/bash -o pipefail -c"));
        assert!(command.contains("bigbud-provider-service"));
        assert!(!command.contains(":127.0.0.1:"), "{command}");
        assert!(!command.contains("ProxyCommand"));
        assert!(!command.contains("ExitOnForwardFailure"));
        assert!(!command.contains("-W "));
        assert!(!command.contains("--session-file"));
    }
    assert!(probe.ends_with("'probe'") || probe.contains(" probe"));
    assert!(probe.contains("probe"));
    assert!(start.contains(" start ") || start.contains(" start"));
    assert!(!start.contains(SESSION));
    assert!(start.ends_with("'' 0"));

    let resume = pi.command(&ProofProviderScope {
        session_file: Some(SESSION.into()),
        ..scope()
    });
    assert!(resume.contains("start"));
    assert!(resume.contains("--session"));
    assert!(resume.contains(&format!("'{SESSION}'")));

    let codex = recipe(Kind::Codex);
    assert!(codex.probe_command().contains("probe"));
    let codex_start = codex.command(&scope());
    assert!(codex_start.ends_with(" start"));
    assert!(!codex_start.contains("--session"));
    assert!(!codex_start.contains(":127.0.0.1:"));
}

#[test]
fn operands_are_quoted_as_data_not_command_text() {
    let quoted = quote("/opt/pi' \"quoted\"; rm -rf /");
    assert_eq!(quoted, "'/opt/pi'\\'' \"quoted\"; rm -rf /'");
    // A configured executable with shell metacharacters stays a single argument.
    let recipe = Recipe::new(Kind::Pi, Path::new("/opt/pi' service"), Path::new(ROOT))
        .expect("absolute path");
    let command = recipe.probe_command();
    assert!(command.contains("'/opt/pi'\\'' service'"));
}
