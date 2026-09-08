use super::BackendRecovery;

#[test]
fn repeated_backend_errors_preserve_failed_recovery_backoff() {
    let mut recovery = BackendRecovery::default();
    recovery.require();
    assert!(recovery.due());

    recovery.failed();
    let scheduled_retry = recovery.retry_at;
    assert!(!recovery.due());

    recovery.require();
    recovery.require();
    assert_eq!(recovery.retry_at, scheduled_retry);
    assert!(!recovery.due());
}
