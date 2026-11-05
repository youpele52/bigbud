#![allow(clippy::unwrap_used, clippy::panic, clippy::panic_in_result_fn)]
//! Private fixtures only: synthetic Mach-O images are hashed, never executed.
//! Every spawn here is refused before exec, and the synthetic image has no
//! load commands, so even a defect could not run code from it.
use super::*;
use crate::{
    Role,
    guard::{
        ControllingLock, GuardServiceConfig, QuiesceOperation, RetainedRecovery,
        SessionInvalidationCause,
        record::SafetyRecord,
        test_support::{TestDirectory, armed},
    },
    owner::{
        image_preflight::{ImagePreflight, macho_tests::thin_bytes},
        private_bootstrap::{BootstrapPermit, PendingChild},
    },
    worker::unix::BootstrapError,
};
use std::{fs, io, os::unix::fs::PermissionsExt, time::Duration};

fn image(base: &TestDirectory) -> ImagePreflight {
    let generation = base.0.join("generation");
    if !generation.exists() {
        fs::create_dir(&generation).unwrap();
        fs::set_permissions(&generation, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(generation.join("guard"), thin_bytes()).unwrap();
        fs::set_permissions(generation.join("guard"), fs::Permissions::from_mode(0o555)).unwrap();
    }
    ImagePreflight::fixture(&base.0, "generation/guard").unwrap()
}
fn election(directory: &TestDirectory, record: &SafetyRecord) -> ControllingLock {
    let lock = ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    lock.journal().replace(record).unwrap();
    lock
}
fn approved(base: &TestDirectory) -> ApprovedGeneration {
    ApprovedGeneration::fixture(Role::Owner, "owner-1", image(base).sha256().unwrap())
}

/// Parallel unit tests in this process may briefly hold inheritable fds
/// (std's non-atomic CLOEXEC on Darwin). Production fails closed; tests retry.
fn transient(error: &io::Error) -> bool {
    error.to_string().contains("inheritable") || error.raw_os_error() == Some(libc::EBADF)
}
fn issue(
    recovery: &mut RetainedRecovery<'_>,
    guard: &LaunchGuard,
    approved: &ApprovedGeneration,
    base: &TestDirectory,
) -> Result<BootstrapPermit, IssueError> {
    for _ in 0..50 {
        match recovery.issue_fixture(guard, approved, Role::Owner, image(base)) {
            Err(IssueError::Descriptors(error)) if transient(&error) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            result => return result,
        }
    }
    panic!("descriptor audit never quiesced")
}
fn spawn_refusal(
    mut make: impl FnMut() -> BootstrapPermit,
    guard: &LaunchGuard,
    role: Role,
    generation: &str,
) -> String {
    for _ in 0..50 {
        match PendingChild::spawn(make(), guard, role, generation) {
            Err(BootstrapError::BeforeSpawn(error)) if transient(&error) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(BootstrapError::BeforeSpawn(error)) => return error.to_string(),
            _ => panic!("spawn was not refused before launch"),
        }
    }
    panic!("descriptor audit never quiesced")
}

#[test]
fn production_has_no_approved_generation_or_direct_permit() {
    for role in [Role::Guard, Role::Owner, Role::Worker, Role::Broker] {
        assert!(ApprovedGeneration::selected(role).is_err());
    }
    assert!(BootstrapPermit::verify().is_err());
}

#[test]
fn every_prerequisite_refuses_independently_then_digest_match_issues() {
    let (state, base) = (TestDirectory::new(), TestDirectory::new());
    let approved = approved(&base);
    let guard = LaunchGuard::acquire().unwrap();
    let mut elected = election(&state, &SafetyRecord::initial());
    let mut recovery = elected.recover_retained();
    assert!(matches!(
        recovery.issue_fixture(&guard, &approved, Role::Worker, image(&base)),
        Err(IssueError::RoleMismatch)
    ));
    assert!(matches!(
        issue(&mut recovery, &guard, &approved, &base),
        Err(IssueError::IdentityUnbound)
    ));
    recovery.bind_fixture_identity().unwrap();
    let wrong = ApprovedGeneration::fixture(Role::Owner, "owner-1", [7; 32]);
    assert!(matches!(
        recovery.issue_fixture(&guard, &wrong, Role::Owner, image(&base)),
        Err(IssueError::DigestMismatch)
    ));
    let permit = issue(&mut recovery, &guard, &approved, &base).unwrap();
    assert_eq!(permit.role(), Role::Owner);
    recovery
        .session_invalidator()
        .invalidate(SessionInvalidationCause::Locked);
    assert!(matches!(
        issue(&mut recovery, &guard, &approved, &base),
        Err(IssueError::SessionInvalidated | IssueError::Storage)
    ));
}

#[test]
fn unsettled_durable_roots_refuse_issuance() {
    let (state, base) = (TestDirectory::new(), TestDirectory::new());
    let approved = approved(&base);
    let guard = LaunchGuard::acquire().unwrap();
    let mut elected = election(&state, &armed());
    let mut recovery = elected.recover_retained();
    recovery.bind_fixture_identity().unwrap();
    assert!(matches!(
        issue(&mut recovery, &guard, &approved, &base),
        Err(IssueError::Storage)
    ));
}

#[test]
fn inheritable_descriptor_refuses_audit_until_closed() {
    let guard = LaunchGuard::acquire().unwrap();
    // SAFETY: dup of stderr yields a fresh descriptor WITHOUT FD_CLOEXEC.
    let leaked = unsafe { libc::dup(libc::STDERR_FILENO) };
    assert!(leaked > 2);
    let refused = guard.audit_descriptors(&[]).is_err();
    // SAFETY: closes only the descriptor this test just created.
    assert_eq!(unsafe { libc::close(leaked) }, 0);
    assert!(refused);
}

#[test]
fn spawn_consumes_permit_and_refuses_mismatch_change_invalidation_and_fence() {
    let (state, base) = (TestDirectory::new(), TestDirectory::new());
    let approved = approved(&base);
    let mut elected = election(&state, &SafetyRecord::initial());
    let mut recovery = elected.recover_retained();
    recovery.bind_fixture_identity().unwrap();
    let guard = LaunchGuard::acquire().unwrap();
    let mut permits: Vec<_> = (0..3)
        .map(|_| issue(&mut recovery, &guard, &approved, &base).unwrap())
        .collect();
    let mismatch = spawn_refusal(|| permits.pop().unwrap(), &guard, Role::Worker, "owner-1");
    assert!(mismatch.contains("mismatch"), "{mismatch}");
    let wrong_generation = spawn_refusal(|| permits.pop().unwrap(), &guard, Role::Owner, "owner-2");
    assert!(wrong_generation.contains("mismatch"), "{wrong_generation}");
    // Quiesce bumps the launch fence: permits issued before it are dead.
    let fenced = permits.pop().unwrap();
    drop(guard);
    let fence = recovery
        .quiesce(
            QuiesceOperation::Update,
            GuardServiceConfig::default(),
            LaunchGuard::acquire().unwrap(),
        )
        .unwrap();
    drop(fence);
    let guard = LaunchGuard::acquire().unwrap();
    let mut once = Some(fenced);
    let refusal = spawn_refusal(|| once.take().unwrap(), &guard, Role::Owner, "owner-1");
    assert!(refusal.contains("fenced"), "{refusal}");
    // Invalidation after issuance refuses at spawn.
    let mut invalidated = Some(issue(&mut recovery, &guard, &approved, &base).unwrap());
    recovery
        .session_invalidator()
        .invalidate(SessionInvalidationCause::UserSwitched);
    let refusal = spawn_refusal(
        || invalidated.take().unwrap(),
        &guard,
        Role::Owner,
        "owner-1",
    );
    assert!(refusal.contains("session invalidated"), "{refusal}");
}

#[test]
fn post_issuance_image_change_refuses_before_exec() {
    let (state, base) = (TestDirectory::new(), TestDirectory::new());
    let approved = approved(&base);
    let mut elected = election(&state, &SafetyRecord::initial());
    let mut recovery = elected.recover_retained();
    recovery.bind_fixture_identity().unwrap();
    let guard = LaunchGuard::acquire().unwrap();
    let mut permit = Some(issue(&mut recovery, &guard, &approved, &base).unwrap());
    let file = base.0.join("generation/guard");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    let refusal = spawn_refusal(|| permit.take().unwrap(), &guard, Role::Owner, "owner-1");
    // Storage revalidation inside the pre-exec re-hash refuses the change.
    assert!(
        refusal.contains("untrusted filesystem identity"),
        "{refusal}"
    );
}

#[test]
fn permits_never_outlive_their_recovery_or_election() {
    let (state, base) = (TestDirectory::new(), TestDirectory::new());
    let approved = approved(&base);
    let guard = LaunchGuard::acquire().unwrap();
    let mut elected = election(&state, &SafetyRecord::initial());
    let mut first = elected.recover_retained();
    first.bind_fixture_identity().unwrap();
    let mut stale = Some(issue(&mut first, &guard, &approved, &base).unwrap());
    drop(first);
    let _second = elected.recover_retained();
    let refusal = spawn_refusal(|| stale.take().unwrap(), &guard, Role::Owner, "owner-1");
    assert!(refusal.contains("fenced"), "{refusal}");
    drop(_second);
    let mut recovery = elected.recover_retained();
    recovery.bind_fixture_identity().unwrap();
    let mut orphan = Some(issue(&mut recovery, &guard, &approved, &base).unwrap());
    drop(recovery);
    drop(elected);
    let refusal = spawn_refusal(|| orphan.take().unwrap(), &guard, Role::Owner, "owner-1");
    assert!(refusal.contains("fenced"), "{refusal}");
}

#[test]
fn digest_drift_missed_by_metadata_refuses_before_exec() {
    let (state, base) = (TestDirectory::new(), TestDirectory::new());
    let approved = approved(&base);
    let mut elected = election(&state, &SafetyRecord::initial());
    let mut recovery = elected.recover_retained();
    recovery.bind_fixture_identity().unwrap();
    let guard = LaunchGuard::acquire().unwrap();
    let mut permit = Some(
        issue(&mut recovery, &guard, &approved, &base)
            .unwrap()
            .with_digest_for_test([3; 32]),
    );
    let refusal = spawn_refusal(|| permit.take().unwrap(), &guard, Role::Owner, "owner-1");
    assert!(refusal.contains("image changed"), "{refusal}");
}

#[test]
fn dropping_the_issuing_recovery_fences_its_permits() {
    let (state, base) = (TestDirectory::new(), TestDirectory::new());
    let approved = approved(&base);
    let guard = LaunchGuard::acquire().unwrap();
    let mut elected = election(&state, &SafetyRecord::initial());
    let mut recovery = elected.recover_retained();
    recovery.bind_fixture_identity().unwrap();
    let mut permit = Some(issue(&mut recovery, &guard, &approved, &base).unwrap());
    drop(recovery);
    // The election is still held and no new recovery exists.
    let refusal = spawn_refusal(|| permit.take().unwrap(), &guard, Role::Owner, "owner-1");
    assert!(refusal.contains("fenced"), "{refusal}");
    drop(elected);
}
