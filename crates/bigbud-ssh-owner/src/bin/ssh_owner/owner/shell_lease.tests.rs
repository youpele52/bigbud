use super::*;

const TARGET: &str = "ssh:host=a";
const GENERATION: Token = [7; 32];

fn lease(
    byte: u8,
    role: ShellRole,
    thread_id: Option<&str>,
    generation: Token,
    run: impl FnOnce(&AtomicBool) -> ShellRun + Send + 'static,
) -> Lease {
    let cancelled = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&cancelled);
    Lease {
        token: [byte; 32],
        role,
        scope: LeaseScope::new(TARGET, generation),
        thread: thread_id.map(str::to_owned),
        cancelled,
        worker: Some(thread::spawn(move || run(&stop))),
        settled: None,
        settled_at: None,
    }
}

/// A command that runs until it is killed.
fn running(stop: &AtomicBool) -> ShellRun {
    while !stop.load(Ordering::Acquire) {
        thread::sleep(POLL);
    }
    ShellRun::Cancelled
}

fn settle(leases: &mut Leases) {
    for lease in &mut leases.0 {
        while lease.worker.is_some() {
            lease.observe();
            thread::sleep(POLL);
        }
    }
}

fn status(byte: u8, role: ShellRole, offset: u64) -> ShellStatus {
    ShellStatus {
        lease: vec![byte; 32],
        role: role.into(),
        offset,
    }
}

fn close(byte: u8, role: ShellRole) -> ShellClose {
    ShellClose {
        lease: vec![byte; 32],
        role: role.into(),
    }
}

fn shell_state(outcome: Result<Outcome, ErrorCode>) -> ShellState {
    match outcome {
        Ok(Outcome::Shell(state)) => state,
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn settled_output_is_read_back_in_bounded_chunks_then_closed() {
    let output = vec![b'x'; CHUNK + 10];
    let mut leases = Leases(vec![lease(
        1,
        ShellRole::Thread,
        None,
        GENERATION,
        move |_| ShellRun::Exited {
            output,
            exit_code: 7,
            truncated: true,
        },
    )]);
    settle(&mut leases);
    let first = shell_state(leases.status(&status(1, ShellRole::Thread, 0)));
    assert_eq!(first.phase, ShellPhase::Exited as i32);
    assert_eq!(first.output.len(), CHUNK);
    assert_eq!(first.output_size, (CHUNK + 10) as u64);
    assert_eq!((first.exit_code, first.truncated), (Some(7), true));
    let rest = shell_state(leases.status(&status(1, ShellRole::Thread, CHUNK as u64)));
    assert_eq!(rest.output.len(), 10);
    assert_eq!(
        leases.status(&status(1, ShellRole::Thread, (CHUNK + 11) as u64)),
        Err(ErrorCode::InvalidOperands)
    );
    let closed = shell_state(leases.close(&close(1, ShellRole::Thread)));
    assert_eq!(closed.phase, ShellPhase::Closed as i32);
    assert!(leases.0.is_empty());
}

#[test]
fn a_lease_never_answers_another_role() {
    let mut leases = Leases(vec![lease(
        2,
        ShellRole::ProviderWorkspace,
        None,
        GENERATION,
        running,
    )]);
    for role in [
        ShellRole::Thread,
        ShellRole::Acp,
        ShellRole::AcpShell,
        ShellRole::Unspecified,
    ] {
        assert_eq!(
            leases.status(&status(2, role, 0)),
            Err(ErrorCode::OperationDenied)
        );
        assert_eq!(
            leases.close(&close(2, role)),
            Err(ErrorCode::OperationDenied)
        );
    }
    let live = shell_state(leases.status(&status(2, ShellRole::ProviderWorkspace, 0)));
    assert_eq!(live.phase, ShellPhase::Running as i32);
    assert_eq!(leases.revoke(), Ok(()));
}

#[test]
fn close_kills_a_running_command_and_confirms_teardown() {
    let mut leases = Leases(vec![lease(3, ShellRole::Acp, None, GENERATION, running)]);
    let closed = shell_state(leases.close(&close(3, ShellRole::Acp)));
    assert_eq!(closed.phase, ShellPhase::Closed as i32);
    assert_eq!(closed.exit_code, None);
    assert!(leases.0.is_empty());
}

#[test]
fn typed_failures_are_reported_once_and_release_the_lease() {
    for (run, expected) in [
        (ShellRun::TimedOut, ErrorCode::ShellTimedOut),
        (ShellRun::Cancelled, ErrorCode::ShellCancelled),
        (
            ShellRun::Failed(ErrorCode::TransportLost),
            ErrorCode::TransportLost,
        ),
        (
            ShellRun::Failed(ErrorCode::WorkspacePathDenied),
            ErrorCode::WorkspacePathDenied,
        ),
    ] {
        let mut leases = Leases(vec![lease(4, ShellRole::Thread, None, GENERATION, |_| run)]);
        settle(&mut leases);
        assert_eq!(
            leases.status(&status(4, ShellRole::Thread, 0)),
            Err(expected)
        );
        assert_eq!(
            leases.status(&status(4, ShellRole::Thread, 0)),
            Err(ErrorCode::OperationDenied)
        );
    }
}

#[test]
fn an_unconfirmed_teardown_is_retained_and_never_replayed() {
    let mut leases = Leases(vec![lease(5, ShellRole::Thread, None, GENERATION, |_| {
        ShellRun::Unconfirmed
    })]);
    settle(&mut leases);
    assert_eq!(
        leases.status(&status(5, ShellRole::Thread, 0)),
        Err(ErrorCode::OutcomeUnknown)
    );
    assert_eq!(
        leases.close(&close(5, ShellRole::Thread)),
        Err(ErrorCode::OutcomeUnknown)
    );
    assert_eq!(leases.revoke(), Err(ErrorCode::OutcomeUnknown));
    assert_eq!(leases.0.len(), 1, "an unconfirmed lease keeps counting");
    leases.sweep(TARGET, [9; 32]);
    assert_eq!(
        leases.0.len(),
        1,
        "a generation change cannot forget it either"
    );
}

#[test]
fn admission_refuses_reuse_a_second_thread_command_and_the_bound() {
    let mut leases = Leases(vec![lease(
        6,
        ShellRole::Thread,
        Some("t1"),
        GENERATION,
        running,
    )]);
    assert_eq!(
        leases.admit(&[6; 32], None),
        Err(ErrorCode::InvalidOperands)
    );
    assert_eq!(
        leases.admit(&[7; 32], Some("t1")),
        Err(ErrorCode::OperationDenied)
    );
    assert_eq!(leases.admit(&[7; 32], Some("t2")), Ok(()));
    for byte in 7..(6 + MAX_LEASES as u8) {
        leases
            .0
            .push(lease(byte, ShellRole::Thread, None, GENERATION, running));
    }
    assert_eq!(leases.admit(&[99; 32], None), Err(ErrorCode::SessionQuota));
    assert_eq!(leases.revoke(), Ok(()));
    assert!(leases.0.is_empty());
}

#[test]
fn a_rotated_generation_retires_older_leases_and_expired_results_are_dropped() {
    let mut leases = Leases(vec![
        lease(8, ShellRole::Thread, None, [1; 32], running),
        lease(9, ShellRole::Thread, None, GENERATION, |_| {
            ShellRun::Exited {
                output: Vec::new(),
                exit_code: 0,
                truncated: false,
            }
        }),
    ]);
    settle_one(&mut leases, 1);
    leases.sweep(TARGET, GENERATION);
    assert_eq!(leases.0.len(), 1);
    assert_eq!(leases.0.first().map(|lease| lease.token), Some([9; 32]));
    if let Some(lease) = leases.0.first_mut() {
        lease.settled_at = Instant::now().checked_sub(SETTLED_TTL);
    }
    leases.sweep(TARGET, GENERATION);
    assert!(leases.0.is_empty());
}

fn settle_one(leases: &mut Leases, index: usize) {
    if let Some(lease) = leases.0.get_mut(index) {
        while lease.worker.is_some() {
            lease.observe();
            thread::sleep(POLL);
        }
    }
}

#[test]
fn an_acp_shell_lease_is_not_the_fixed_acp_recipe_lease() {
    let mut leases = Leases(vec![lease(
        12,
        ShellRole::AcpShell,
        None,
        GENERATION,
        running,
    )]);
    assert_eq!(
        leases.status(&status(12, ShellRole::Acp, 0)),
        Err(ErrorCode::OperationDenied)
    );
    assert_eq!(
        leases.close(&close(12, ShellRole::Acp)),
        Err(ErrorCode::OperationDenied)
    );
    let closed = shell_state(leases.close(&close(12, ShellRole::AcpShell)));
    assert_eq!(closed.phase, ShellPhase::Closed as i32);
}
