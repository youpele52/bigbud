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
    assert!(matches!(
        session.accept_operation("operation-over-limit", vec![1]),
        Err(SessionError::ResourceLimit(_))
    ));

    for operation in session.accepted_operations.values_mut() {
        operation.expires_at = Instant::now();
    }
    assert!(
        !session
            .accept_operation("operation-after-expiry", vec![2])
            .unwrap()
    );
}
