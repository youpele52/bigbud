use super::targets::Lanes;
use super::{
    Error, ErrorCode, Instant, Operation, Outcome, Owner, Payload, Pipe, ProofGrantReply, Read,
    Reply, Request, RunResult, Write, protocol_error,
};
use crate::owner_grants::Binding;

impl Owner {
    pub(crate) fn serve_session<R: Read, W: Write>(
        &mut self,
        pipe: &mut Pipe<R, W>,
        mut before_io: impl FnMut(bool) -> std::io::Result<()>,
    ) -> RunResult<()> {
        loop {
            before_io(true)?;
            let Some(message) = pipe.recv()? else {
                return Ok(());
            };
            before_io(false)?;
            let reply = match message {
                Payload::ProofGrantRequest(request) => {
                    Payload::ProofGrantReply(self.issue(request))
                }
                Payload::Request(request) => Payload::Reply(self.request(pipe, request)?),
                _ => return Err(protocol_error().into()),
            };
            before_io(false)?;
            pipe.send(reply)?;
        }
    }

    pub(super) fn issue(&mut self, request: Request) -> ProofGrantReply {
        let grant = self.validate(&request).and_then(|operation| {
            // Resolution validates and caches the target; it dials nothing.
            let mut resolved = None;
            if requires_target(&operation, self.authority.is_some()) {
                let bound = self
                    .transport
                    .as_ref()
                    .map(|_| (self.target.as_ref(), self.generation));
                let preview = self
                    .targets
                    .resolve(self.authority.as_ref(), &request, bound)?;
                self.targets.storage_available(&preview.target_id)?;
                resolved = Some(preview.target_id);
            }
            // An ambiguous write for one target refuses only that target; the
            // other targets' lanes are untouched.
            if resolved.as_deref().is_some_and(|target| {
                self.target_lanes(target)
                    .is_some_and(Lanes::terminal_uncertain)
            }) {
                return Err(ErrorCode::OutcomeUnknown);
            }
            // The grant binds the target and the generation the caller named;
            // a first use names none and adopts the resolved generation.
            let binding = Binding {
                target_id: request.target_id.clone(),
                generation: request.target_generation.clone(),
            };
            self.grants
                .issue(&request, binding, operation, Instant::now())
        });
        let (grant, error) = match grant {
            Ok(token) => (token.to_vec(), ErrorCode::Unspecified),
            Err(error) => (Vec::new(), error),
        };
        ProofGrantReply {
            request_id: request.request_id,
            grant,
            error: error.into(),
        }
    }

    pub(super) fn request<R: Read, W: Write>(
        &mut self,
        pipe: &mut Pipe<R, W>,
        request: Request,
    ) -> RunResult<Reply> {
        let admitted = self.validate(&request).and_then(|operation| {
            let binding = self
                .grants
                .consume(&request, operation.clone(), Instant::now())?;
            Ok((operation, binding))
        });
        let (outcome, generation) = match admitted {
            Ok((operation, binding)) => match self.prepare_target(pipe, &binding, &operation)? {
                Ok(()) => {
                    let result = self.execute(pipe, &request.request_id, operation);
                    // Capture the exact target's generation before the at-rest
                    // binding is restored.
                    let generation = self.generation;
                    self.leave_target();
                    (result?, generation)
                }
                Err(error) => (
                    Err(error),
                    self.targets
                        .generation(&binding.target_id)
                        .unwrap_or(self.generation),
                ),
            },
            Err(error) => {
                // Report the target's current generation when it is known, so a
                // client can recover from a stale or first-use refusal.
                let generation = if request.target_id == self.target && self.transport.is_some() {
                    self.generation
                } else {
                    self.targets
                        .generation(&request.target_id)
                        .unwrap_or(self.generation)
                };
                (Err(error), generation)
            }
        };
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(code) => Outcome::Error(Error {
                code: code.into(),
                jump_failure: None,
            }),
        };
        Ok(Reply {
            request_id: request.request_id,
            owner_epoch: self.epoch.to_vec(),
            // The exact target's current generation, so a first use and every
            // Connect/Disconnect rotation are learned per target.
            target_generation: generation.to_vec(),
            outcome: Some(outcome),
        })
    }

    /// Validates the grant's generation against the resolved target and hydrates
    /// its durable state before the target is bound for dispatch.
    fn prepare_target<R: Read, W: Write>(
        &mut self,
        pipe: &mut Pipe<R, W>,
        binding: &Binding,
        operation: &Operation,
    ) -> RunResult<Result<(), ErrorCode>> {
        if !requires_target(operation, self.authority.is_some()) {
            return Ok(Ok(()));
        }
        if !binding.generation.is_empty() {
            let current = if binding.target_id == self.target && self.transport.is_some() {
                self.generation
            } else {
                let Some(current) = self.targets.generation(&binding.target_id) else {
                    return Ok(Err(ErrorCode::TargetUnknown));
                };
                current
            };
            if binding.generation != current {
                return Ok(Err(ErrorCode::StaleGeneration));
            }
        }
        let bound = binding.target_id == self.target && self.transport.is_some();
        if !bound {
            // A target that has not hydrated yet asks the authenticated peer for
            // its durable snapshot before any network operation is admitted.
            if super::dispatch::needs_storage(operation) {
                match self.targets.ensure_storage(pipe, &binding.target_id)? {
                    Ok(()) => {}
                    Err(error) => return Ok(Err(error)),
                }
            }
        } else if super::dispatch::needs_storage(operation)
            && let Err(error) = self.storage.available()
        {
            return Ok(Err(error));
        }
        Ok(self.enter_target(&binding.target_id))
    }
}

/// Owner-scoped discovery reads no target and opens no transport. In production
/// the alias list comes from the owner's own config scope.
fn requires_target(operation: &Operation, production: bool) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if production && super::peer_store::owner_wide_verb(operation) {
        return false;
    }
    !production || !matches!(operation, Operation::ListAliases(_))
}
