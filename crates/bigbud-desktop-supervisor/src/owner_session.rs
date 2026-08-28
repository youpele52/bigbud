use crate::{
    Limits, PROTOCOL_MAJOR, PROTOCOL_MINOR, RecoveryAction, Supervisor, SupervisorError, v1,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HandshakeState {
    AwaitingHello,
    Ready,
    Rejected,
}

#[derive(Debug, PartialEq)]
pub struct SessionResult {
    pub responses: Vec<v1::Frame>,
    pub close: bool,
}

#[derive(Debug)]
pub struct OwnerSession {
    state: HandshakeState,
    limits: Limits,
    supervisor_instance_id: String,
}

impl OwnerSession {
    pub fn new(limits: Limits, supervisor_instance_id: String) -> Self {
        Self {
            state: HandshakeState::AwaitingHello,
            limits,
            supervisor_instance_id,
        }
    }

    pub fn handle_frame(
        &mut self,
        supervisor: &mut Supervisor,
        frame: v1::Frame,
        now_ms: u64,
    ) -> Result<SessionResult, SupervisorError> {
        match self.state {
            HandshakeState::AwaitingHello => return Ok(self.handle_hello(frame)),
            HandshakeState::Rejected => {
                return Ok(SessionResult {
                    responses: vec![protocol_error(
                        "session_rejected",
                        "desktop owner session has already been rejected",
                    )],
                    close: true,
                });
            }
            HandshakeState::Ready => {}
        }

        let mut close = false;
        let operation = (|| -> Result<Vec<v1::Frame>, SupervisorError> {
            Ok(match frame.payload {
                Some(v1::frame::Payload::AttachConsumer(attach)) => {
                    let acknowledged_sequence = supervisor.attach(
                        attach.consumer_id.clone(),
                        attach.consumer_generation,
                        attach.server_epoch,
                        attach.applied_sequence,
                    )?;
                    vec![v1::Frame {
                        payload: Some(v1::frame::Payload::ConsumerAttached(v1::ConsumerAttached {
                            consumer_id: attach.consumer_id,
                            consumer_generation: attach.consumer_generation,
                            acknowledged_sequence,
                        })),
                    }]
                }
                Some(v1::frame::Payload::DetachConsumer(detach)) => {
                    supervisor.detach(&detach.consumer_id, detach.consumer_generation)?;
                    Vec::new()
                }
                Some(v1::frame::Payload::EventBatch(batch)) => {
                    let consumer_id = batch.consumer_id.clone();
                    let generation = batch.consumer_generation;
                    if let Some(delivery) = supervisor.duplicate_delivery(&batch, now_ms)? {
                        delivery_frame(Some(delivery))
                    } else if let Some(action) = supervisor.enqueue(batch)? {
                        vec![recovery_frame(action)]
                    } else {
                        let delivery =
                            supervisor.next_delivery(&consumer_id, generation, now_ms)?;
                        if delivery.is_some() {
                            delivery_frame(delivery)
                        } else {
                            vec![recovery_frame(supervisor.recovery_required(
                                &consumer_id,
                                generation,
                                v1::RecoveryKind::Replay,
                                "duplicate_batch_not_retained",
                            )?)]
                        }
                    }
                }
                Some(v1::frame::Payload::ApplicationAck(ack)) => {
                    let consumer_id = ack.consumer_id.clone();
                    let generation = ack.consumer_generation;
                    supervisor.acknowledge(&ack)?;
                    let mut responses = vec![v1::Frame {
                        payload: Some(v1::frame::Payload::ApplicationAckAccepted(
                            v1::ApplicationAckAccepted {
                                batch_id: ack.batch_id,
                                consumer_id: consumer_id.clone(),
                                consumer_generation: generation,
                                acknowledged_sequence: ack.applied_through_sequence,
                            },
                        )),
                    }];
                    responses.extend(delivery_frame(supervisor.next_delivery(
                        &consumer_id,
                        generation,
                        now_ms,
                    )?));
                    responses
                }
                Some(v1::frame::Payload::Heartbeat(heartbeat)) => vec![v1::Frame {
                    payload: Some(v1::frame::Payload::Heartbeat(heartbeat)),
                }],
                Some(v1::frame::Payload::MetricsSnapshot(_)) => vec![v1::Frame {
                    payload: Some(v1::frame::Payload::MetricsSnapshot(
                        supervisor.metrics(now_ms),
                    )),
                }],
                Some(v1::frame::Payload::Shutdown(_)) => {
                    close = true;
                    Vec::new()
                }
                Some(v1::frame::Payload::ClientHello(_)) => {
                    close = true;
                    vec![protocol_error(
                        "duplicate_hello",
                        "desktop owner sent ClientHello after handshake completion",
                    )]
                }
                Some(_) | None => vec![protocol_error(
                    "unexpected_frame",
                    "frame is not accepted from the desktop owner",
                )],
            })
        })();
        match operation {
            Ok(responses) => Ok(SessionResult { responses, close }),
            Err(error) if error.is_fatal_session_error() => {
                self.state = HandshakeState::Rejected;
                Ok(SessionResult {
                    responses: vec![error_frame(&error)],
                    close: true,
                })
            }
            Err(error) => Err(error),
        }
    }

    fn handle_hello(&mut self, frame: v1::Frame) -> SessionResult {
        let Some(v1::frame::Payload::ClientHello(hello)) = frame.payload else {
            self.state = HandshakeState::Rejected;
            return SessionResult {
                responses: vec![protocol_error(
                    "handshake_required",
                    "ClientHello must be the first desktop owner frame",
                )],
                close: true,
            };
        };
        if hello.protocol_major != PROTOCOL_MAJOR {
            self.state = HandshakeState::Rejected;
            return SessionResult {
                responses: vec![protocol_error(
                    "incompatible_protocol",
                    "desktop supervisor protocol major is incompatible",
                )],
                close: true,
            };
        }
        self.state = HandshakeState::Ready;
        SessionResult {
            responses: vec![v1::Frame {
                payload: Some(v1::frame::Payload::SupervisorHello(v1::SupervisorHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    supervisor_instance_id: self.supervisor_instance_id.clone(),
                    accepted_limits: Some(limits_frame(self.limits)),
                })),
            }],
            close: false,
        }
    }
}

fn delivery_frame(delivery: Option<crate::Delivery>) -> Vec<v1::Frame> {
    delivery
        .map(|delivery| v1::Frame {
            payload: Some(v1::frame::Payload::EventBatch(delivery.batch)),
        })
        .into_iter()
        .collect()
}

fn limits_frame(limits: Limits) -> v1::Limits {
    v1::Limits {
        max_frame_bytes: crate::DEFAULT_MAX_FRAME_BYTES as u64,
        max_consumers: limits.max_consumers as u64,
        max_queue_events: limits.max_queue_events as u64,
        max_queue_bytes: limits.max_queue_bytes as u64,
        max_in_flight_events: limits.max_in_flight_events as u64,
        acknowledgement_timeout_ms: limits.acknowledgement_timeout_ms,
    }
}

pub fn recovery_frame(action: RecoveryAction) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::RecoveryRequired(v1::RecoveryRequired {
            consumer_id: action.consumer_id,
            consumer_generation: action.consumer_generation,
            kind: action.kind as i32,
            from_sequence_exclusive: action.from_sequence_exclusive,
            reason_code: action.reason_code.to_owned(),
        })),
    }
}

pub fn error_frame(error: &SupervisorError) -> v1::Frame {
    let code = match error {
        SupervisorError::ConsumerLimit => "consumer_limit",
        SupervisorError::ConsumerMissing => "consumer_missing",
        SupervisorError::StaleConsumerGeneration => "stale_consumer_generation",
        SupervisorError::AttachSequenceRollback => "attach_sequence_rollback",
        SupervisorError::AttachStateConflict => "attach_state_conflict",
        SupervisorError::ServerEpochMismatch => "server_epoch_mismatch",
        SupervisorError::EmptyBatch => "empty_batch",
        SupervisorError::NonContiguousSequence => "non_contiguous_sequence",
        SupervisorError::InFlightLimit => "in_flight_limit",
        SupervisorError::UnknownBatch => "unknown_batch",
        SupervisorError::AckBeyondSent => "ack_beyond_sent",
        SupervisorError::IncompleteAck => "incomplete_ack",
        SupervisorError::AckMovedBackward => "ack_moved_backward",
        SupervisorError::BatchIdentityConflict => "batch_identity_conflict",
        SupervisorError::InvalidBatchIdentity => "invalid_batch_identity",
    };
    protocol_error(code, &error.to_string())
}

fn protocol_error(code: &str, message: &str) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ProtocolError(v1::ProtocolError {
            code: code.to_owned(),
            message: message.to_owned(),
        })),
    }
}

#[cfg(test)]
#[path = "owner_session.tests.rs"]
mod tests;
