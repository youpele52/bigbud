use crate::{
    RunResult, Token,
    owner_pipe::{PayloadPipe, protocol_error},
    random_token,
    v1::{
        ErrorCode, ProofStorageHydrate, ProofStorageResult, ProofStorageSnapshot,
        ProofStorageTransition, frame::Payload,
    },
};

const MAX_SEQUENCE: u64 = (1 << 53) - 1;

pub(super) struct Storage {
    writer_epoch: String,
    seq: u64,
    disconnected: bool,
    failed: bool,
}

impl Storage {
    /// The at-rest state of an owner that has no target yet (production mode).
    /// Every question except a fresh hydration answers `StorageUnavailable`.
    pub(super) fn unhydrated() -> Self {
        Self {
            writer_epoch: String::new(),
            seq: 0,
            disconnected: false,
            failed: true,
        }
    }

    pub(super) fn hydrate(pipe: &mut impl PayloadPipe, target: &str) -> RunResult<Self> {
        pipe.send(Payload::ProofStorageHydrate(ProofStorageHydrate {
            target_id: target.into(),
        }))?;
        let Some(Payload::ProofStorageSnapshot(snapshot)) = pipe.recv()? else {
            return Err(protocol_error().into());
        };
        Self::from_snapshot(snapshot, target)
    }

    fn from_snapshot(snapshot: ProofStorageSnapshot, target: &str) -> RunResult<Self> {
        if snapshot.target_id != target
            || snapshot.error != ErrorCode::Unspecified as i32
            || snapshot.writer_epoch.is_empty()
            || snapshot.writer_epoch.len() > 128
            || snapshot.seq > MAX_SEQUENCE
        {
            return Err(protocol_error().into());
        }
        Ok(Self {
            writer_epoch: snapshot.writer_epoch,
            seq: snapshot.seq,
            disconnected: snapshot.disconnected,
            failed: false,
        })
    }

    pub(super) fn available(&self) -> Result<(), ErrorCode> {
        if self.failed {
            Err(ErrorCode::StorageUnavailable)
        } else {
            Ok(())
        }
    }

    pub(super) fn allow_network(&self) -> Result<(), ErrorCode> {
        self.available()?;
        if self.disconnected {
            Err(ErrorCode::TargetDisconnected)
        } else {
            Ok(())
        }
    }

    pub(super) fn transition(
        &mut self,
        pipe: &mut impl PayloadPipe,
        target: &str,
        request_id: &[u8],
        disconnected: bool,
    ) -> RunResult<Result<Token, ErrorCode>> {
        if let Err(error) = self.available() {
            return Ok(Err(error));
        }
        if self.seq >= MAX_SEQUENCE {
            self.failed = true;
            return Ok(Err(ErrorCode::StorageUnavailable));
        }
        // Generate the next fence before sending any potentially durable mutation.
        let next_generation = random_token()?;
        let request = ProofStorageTransition {
            request_id: request_id.to_vec(),
            target_id: target.into(),
            writer_epoch: self.writer_epoch.clone(),
            expected_seq: self.seq,
            disconnected,
        };
        // I/O or decode errors end the pipe session. An accepted mutation is never retried.
        pipe.send(Payload::ProofStorageTransition(request.clone()))?;
        let Some(Payload::ProofStorageResult(ack)) = pipe.recv()? else {
            return Err(protocol_error().into());
        };
        Ok(self.apply_ack(&request, ack).map(|()| next_generation))
    }

    fn apply_ack(
        &mut self,
        request: &ProofStorageTransition,
        ack: ProofStorageResult,
    ) -> Result<(), ErrorCode> {
        if ack.request_id != request.request_id {
            self.failed = true;
            return Err(ErrorCode::OutcomeUnknown);
        }
        if !ack.committed && ack.error == ErrorCode::StorageUnavailable as i32 {
            self.failed = true;
            return Err(ErrorCode::StorageUnavailable);
        }
        if !ack.committed || ack.error != ErrorCode::Unspecified as i32 || ack.seq != self.seq + 1 {
            self.failed = true;
            return Err(ErrorCode::OutcomeUnknown);
        }
        self.seq = ack.seq;
        self.disconnected = request.disconnected;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hydrated() -> Storage {
        Storage::from_snapshot(
            ProofStorageSnapshot {
                target_id: "target".into(),
                writer_epoch: "writer".into(),
                seq: 3,
                disconnected: true,
                error: 0,
            },
            "target",
        )
        .unwrap()
    }

    #[test]
    fn hydrated_disconnect_requires_a_matching_commit_to_reopen() {
        let mut state = hydrated();
        let request = ProofStorageTransition {
            request_id: vec![1],
            disconnected: false,
            ..ProofStorageTransition::default()
        };
        assert_eq!(state.allow_network(), Err(ErrorCode::TargetDisconnected));
        state
            .apply_ack(
                &request,
                ProofStorageResult {
                    request_id: vec![1],
                    seq: 4,
                    committed: true,
                    error: 0,
                },
            )
            .unwrap();
        assert_eq!(state.allow_network(), Ok(()));
        assert_eq!(state.seq, 4);
    }

    #[test]
    fn invalid_or_unconfirmed_commit_poison_admission() {
        let request = ProofStorageTransition {
            request_id: vec![1],
            disconnected: false,
            ..ProofStorageTransition::default()
        };
        let good = ProofStorageResult {
            request_id: request.request_id.clone(),
            seq: 4,
            committed: true,
            error: 0,
        };
        for bad in [
            ProofStorageResult {
                request_id: vec![9],
                ..good.clone()
            },
            ProofStorageResult {
                seq: 3,
                ..good.clone()
            },
            ProofStorageResult {
                error: 99,
                ..good.clone()
            },
            ProofStorageResult {
                committed: false,
                ..good
            },
        ] {
            let mut state = hydrated();
            assert_eq!(
                state.apply_ack(&request, bad),
                Err(ErrorCode::OutcomeUnknown)
            );
            assert_eq!(state.seq, 3);
            assert!(state.disconnected);
            assert_eq!(state.allow_network(), Err(ErrorCode::StorageUnavailable));
        }
    }
}
