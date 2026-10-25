use super::*;

#[test]
fn expired_mutation_identities_release_capacity() {
    let mut session = AgentSession::new().unwrap();
    for index in 0..MAX_ACCEPTED_OPERATIONS {
        assert!(
            !session
                .accept_operation(&format!("operation-{index}"), index.to_le_bytes().to_vec())
                .unwrap()
        );
    }

    for operation in session.accepted_operations.values_mut() {
        operation.expires_at = Instant::now();
    }
    assert!(
        !session
            .accept_operation("operation-after-expiry", vec![2])
            .unwrap()
    );
    assert_eq!(session.accepted_operations.len(), 1);
}

#[test]
fn accepted_identities_are_kept_for_a_day() {
    let mut session = AgentSession::new().unwrap();
    let before = Instant::now();
    session.accept_operation("operation-1", vec![1]).unwrap();
    let expires_at = session.accepted_operations["operation-1"].expires_at;
    assert!(expires_at >= before + Duration::from_secs(24 * 60 * 60));
    assert!(session.accept_operation("operation-1", vec![1]).unwrap());
    assert!(matches!(
        session.accept_operation("operation-1", vec![2]),
        Err(SessionError::OperationIdConflict)
    ));
}

#[test]
fn a_full_identity_table_evicts_the_oldest_instead_of_refusing_work() {
    let mut session = AgentSession::new().unwrap();
    for index in 0..MAX_ACCEPTED_OPERATIONS {
        session
            .accept_operation(&format!("operation-{index}"), vec![1])
            .unwrap();
    }
    let base = Instant::now();
    for (index, operation) in session.accepted_operations.iter_mut() {
        let order: u64 = index.trim_start_matches("operation-").parse().unwrap();
        operation.expires_at = base + Duration::from_secs(60 + order);
    }

    assert!(!session.accept_operation("operation-new", vec![1]).unwrap());
    assert_eq!(session.accepted_operations.len(), MAX_ACCEPTED_OPERATIONS);
    assert!(!session.accepted_operations.contains_key("operation-0"));
    assert!(session.accepted_operations.contains_key("operation-1"));
    assert!(session.accept_operation("operation-1", vec![1]).unwrap());
}
