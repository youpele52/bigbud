use super::{
    Error, ErrorCode, Instant, Outcome, Owner, Payload, Pipe, ProofGrantReply, Read, Reply,
    Request, RunResult, Write, protocol_error,
};

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
            self.storage.available()?;
            if self.terminal_uncertain {
                return Err(ErrorCode::OutcomeUnknown);
            }
            self.grants.issue(&request, operation, Instant::now())
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
            self.grants
                .consume(&request, operation.clone(), Instant::now())?;
            Ok(operation)
        });
        let outcome = match admitted {
            Ok(operation) => self.execute(pipe, &request.request_id, operation)?,
            Err(error) => Err(error),
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
            target_generation: self.generation.to_vec(),
            outcome: Some(outcome),
        })
    }
}
