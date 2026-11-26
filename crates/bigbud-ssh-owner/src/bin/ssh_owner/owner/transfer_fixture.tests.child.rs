use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

use super::super::child::{NativeTransferRecipe, SupervisedChild};
use super::super::{ErrorCode, LaunchAttempt, TransferVerb};
use super::{FixtureDirectory, grant, no_launch, operands, scope};
use crate::v1;

fn recipe(
    dir: &FixtureDirectory,
    program: &Path,
    ssh: &Path,
    extra_env: Vec<(String, String)>,
) -> NativeTransferRecipe {
    let mut env = vec![
        ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
        ("BIGBUD_FIXTURE".to_string(), "1".to_string()),
    ];
    env.extend(extra_env);
    NativeTransferRecipe::fixed(
        program.to_path_buf(),
        vec!["--fixed-arg".into()],
        ssh.to_path_buf(),
        vec!["-o".into(), "BatchMode=yes".into()],
        env,
        dir.path().to_path_buf(),
    )
}

fn ssh_fixture(dir: &FixtureDirectory) -> std::path::PathBuf {
    dir.executable("ssh-fixture.sh", "#!/bin/sh\nexit 0\n")
}

fn wait_for_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !path.exists() {
        assert!(Instant::now() < deadline, "missing {}", path.display());
        thread::sleep(Duration::from_millis(5));
    }
}

fn drain_progress(child: &SupervisedChild, expected: usize) -> Vec<v1::ProofTransferChildProgress> {
    let mut samples = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(2);
    while samples.len() < expected && Instant::now() < deadline {
        samples.extend(child.progress());
        if samples.len() < expected {
            thread::sleep(Duration::from_millis(5));
        }
    }
    samples
}

fn progress(lease: &[u8], bytes: u64, items: u32) -> v1::ProofTransferChildProgress {
    v1::ProofTransferChildProgress {
        lease: lease.to_vec(),
        phase: "progress".into(),
        bytes,
        items,
    }
}

#[test]
fn transfer_fixture_child_reports_progress_and_exit() {
    let dir = FixtureDirectory::new();
    let ssh = ssh_fixture(&dir);
    let script = dir.executable(
        "transfer.sh",
        "#!/bin/sh\nset -eu\nprintf 'progress 1 1\\n'\nprintf 'progress 2 2\\n'\nexit 3\n",
    );
    let recipe = recipe(&dir, &script, &ssh, Vec::new());
    let mut child = SupervisedChild::spawn(
        grant(TransferVerb::PackagedRsync, 1),
        &recipe,
        &operands(4096),
        &no_launch(),
    )
    .expect("supervised child");
    let exit = child.finish().expect("child exit");
    assert_eq!(exit.code, Some(3));
    assert_eq!(exit.signal, None);
    assert!(!exit.cancelled);
    let lease = child.lease().to_vec();
    assert_eq!(
        drain_progress(&child, 2),
        vec![progress(&lease, 1, 1), progress(&lease, 2, 2)]
    );
    let state = child.state();
    assert!(state.exited);
    assert_eq!(state.exit_code, Some(3));
    assert!(!state.cancelled);
    assert_eq!(state.charged_trees, 1);
    assert_eq!(child.charged_trees(), 1);
    assert!(child.exit().is_ok());
    assert_eq!(child.exit(), Err(ErrorCode::OperationDenied));
}

#[test]
fn transfer_fixture_child_controls_exact_dash_e_argv_and_environment() {
    let dir = FixtureDirectory::new();
    let ssh = ssh_fixture(&dir);
    let args = dir.join("args.txt");
    let env = dir.join("env.txt");
    let script = dir.executable(
        "argv.sh",
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ARGS_FILE\"\nenv > \"$ENV_FILE\"\nexit 0\n",
    );
    let recipe = recipe(
        &dir,
        &script,
        &ssh,
        vec![
            ("ARGS_FILE".into(), args.display().to_string()),
            ("ENV_FILE".into(), env.display().to_string()),
        ],
    );
    assert_eq!(recipe.ssh_program(), ssh.as_path());
    assert_eq!(recipe.argv(), ["--fixed-arg"]);
    let mut child = SupervisedChild::spawn(
        grant(TransferVerb::PackagedRsync, 1),
        &recipe,
        &operands(4096),
        &no_launch(),
    )
    .expect("supervised child");
    child.finish().expect("child exit");
    wait_for_file(&args);
    let argv: Vec<String> = fs::read_to_string(&args)
        .expect("argv")
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(
        argv,
        [
            "--fixed-arg",
            "-e",
            ssh.to_str().expect("ssh path"),
            "-o",
            "BatchMode=yes",
            "--",
            "fixture/source",
            "fixture/destination",
        ]
    );
    let environment = fs::read_to_string(&env).expect("env");
    assert!(environment.lines().any(|line| line == "BIGBUD_FIXTURE=1"));
    assert!(!environment.contains("BIGBUD_CALLER_ENV"));

    // Every caller-supplied escape hatch is refused typed and spawns nothing.
    for attempt in [
        LaunchAttempt {
            executable: "/bin/sh".into(),
            ..LaunchAttempt::default()
        },
        LaunchAttempt {
            argv: vec!["--rsync-path=/bin/sh".into()],
            ..LaunchAttempt::default()
        },
        LaunchAttempt {
            env: vec!["BIGBUD_CALLER_ENV=1".into()],
            ..LaunchAttempt::default()
        },
        LaunchAttempt {
            ssh_option: "-o ProxyCommand=sh".into(),
            ..LaunchAttempt::default()
        },
    ] {
        let _removed = fs::remove_file(&args);
        assert_eq!(
            SupervisedChild::spawn(
                grant(TransferVerb::PackagedRsync, 1),
                &recipe,
                &operands(4096),
                &attempt,
            )
            .err(),
            Some(ErrorCode::InvalidOperands),
            "{attempt:?}"
        );
        assert!(!args.exists());
    }
}

#[test]
fn transfer_fixture_child_tree_is_charged_and_killed_as_one_lease() {
    let dir = FixtureDirectory::new();
    let ssh = ssh_fixture(&dir);
    let pid_file = dir.join("grandchild.txt");
    let script = dir.executable(
        "tree.sh",
        "#!/bin/sh\nsleep 30 &\nprintf '%s\\n' \"$!\" > \"$GRANDCHILD_FILE\"\nexit 0\n",
    );
    let recipe = recipe(
        &dir,
        &script,
        &ssh,
        vec![("GRANDCHILD_FILE".into(), pid_file.display().to_string())],
    );
    let mut child = SupervisedChild::spawn(
        grant(TransferVerb::PackagedRsync, 1),
        &recipe,
        &operands(4096),
        &no_launch(),
    )
    .expect("supervised child");
    child.finish().expect("direct child exit");
    wait_for_file(&pid_file);
    let grandchild: i32 = fs::read_to_string(&pid_file)
        .expect("grandchild pid")
        .trim()
        .parse()
        .expect("numeric pid");
    child.kill_tree().expect("tree reaped");
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        // SAFETY: signal 0 only observes the positive pid the fixture script
        // wrote for its own child; the owner never signals a worker value.
        let alive = unsafe { libc::kill(grandchild, 0) } == 0;
        if !alive {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "grandchild {grandchild} survived"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn transfer_fixture_child_cancel_and_unknown_outcome_never_replay() {
    let dir = FixtureDirectory::new();
    let ssh = ssh_fixture(&dir);
    let script = dir.executable(
        "sleep.sh",
        "#!/bin/sh\nprintf 'progress 1 1\\n'\nexec sleep 30\n",
    );
    let recipe = recipe(&dir, &script, &ssh, Vec::new());
    let mut child = SupervisedChild::spawn(
        grant(TransferVerb::PackagedRsync, 1),
        &recipe,
        &operands(4096),
        &no_launch(),
    )
    .expect("supervised child");
    let lease = child.lease().to_vec();
    assert_eq!(child.cancel(&[0; 32]), Err(ErrorCode::OperationDenied));
    assert_eq!(child.cancel(&lease), Ok(()));
    assert!(child.state().cancelled);
    let exit = child.exit().expect("cancelled exit");
    assert!(exit.cancelled);
    assert_eq!(exit.signal, Some(libc::SIGKILL));
    assert_eq!(child.cancel(&lease), Err(ErrorCode::OperationDenied));

    let mut lost = SupervisedChild::spawn(
        grant(TransferVerb::PackagedRsync, 1),
        &recipe,
        &operands(4096),
        &no_launch(),
    )
    .expect("supervised child");
    lost.mark_transport_lost();
    assert_eq!(lost.exit(), Err(ErrorCode::OutcomeUnknown));
    assert_eq!(lost.finish(), Err(ErrorCode::OperationDenied));
}

fn digest(operation: &v1::request::Operation) -> [u8; 32] {
    use prost::Message;

    let mut preimage = b"bigbud.ssh_owner.v1/operands\0".to_vec();
    v1::Request {
        operation: Some(operation.clone()),
        ..v1::Request::default()
    }
    .encode(&mut preimage)
    .expect("encoding into an owned Vec is infallible");
    Sha256::digest(preimage).into()
}

fn hex32(hex: &str) -> [u8; 32] {
    let bytes = hex.as_bytes();
    assert_eq!(bytes.len(), 64, "expected a 32-byte hex digest");
    let mut value = [0; 32];
    for (index, byte) in value.iter_mut().enumerate() {
        let pair = std::str::from_utf8(&bytes[index * 2..index * 2 + 2]).expect("ascii hex");
        *byte = u8::from_str_radix(pair, 16).expect("hex");
    }
    value
}

/// C15 / W2 T-xfer grant separation. The checked-in digest is the same value
/// the TS and Rust protocol goldens pin for `proof_transfer_stream`; the other
/// roles never share it.
#[test]
fn transfer_fixture_grant_digest_separates_transfer_from_pty_shell_and_peer() {
    use v1::request::Operation;

    let stream = Operation::TransferStream(v1::ProofTransferStream {
        scope: Some(scope(2)),
        operands: Some(v1::ProofTransferOperands {
            source: "fixture/source".into(),
            destination: "fixture/destination".into(),
            max_bytes: 4096,
            max_entries: 8,
        }),
        launch_attempt: None,
    });
    let packaged = Operation::PackagedRsync(v1::ProofPackagedRsync {
        scope: Some(scope(1)),
        operands: Some(v1::ProofTransferOperands {
            source: "fixture/tree-a".into(),
            destination: "fixture/tree-b".into(),
            max_bytes: 8192,
            max_entries: 4,
        }),
        launch_attempt: None,
    });
    let pty = Operation::OpenTerminal(v1::ProofTerminalOpen { lease: vec![1] });
    let shell = Operation::ProofRunThreadShell(v1::ProofRunThreadShell {
        workspace_root: "/fixture/root".into(),
        cwd: "/fixture/root".into(),
        thread_id: "thread-1".into(),
        command: "true".into(),
        timeout_ms: 1_000,
    });
    let peer = Operation::ProofPeerRelayOpen(v1::ProofPeerRelayOpen {
        pairing_id: "pairing-1".into(),
        grant_id: "grant-1".into(),
        worker_authority_id: "worker-1".into(),
        host_key_fingerprint: "SHA256:fixture".into(),
        coordinator_key_fingerprint: "sha256:fixture".into(),
    });
    let trust = Operation::InspectTrust(v1::Empty {});

    assert_eq!(
        digest(&stream),
        hex32("7fdc1e31340727d81c46a34c0b1ca603a54fd029316eecf5301872de4dd0c16b")
    );
    assert_eq!(
        digest(&packaged),
        hex32("b7571ec86ce93771adcdfea98578d960ca0402f86aceb243b5d5411ea5711702")
    );
    let values = [stream, packaged, pty, shell, peer, trust].map(|operation| digest(&operation));
    for (index, left) in values.iter().enumerate() {
        for right in values.iter().skip(index + 1) {
            assert_ne!(left, right, "transfer grants must not be substitutable");
        }
    }
}
