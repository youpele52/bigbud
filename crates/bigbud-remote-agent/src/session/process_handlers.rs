use super::*;

impl AgentSession {
    pub fn handle_process_request(
        &mut self,
        request: v1::ProcessRequest,
    ) -> Result<Vec<v1::Frame>, SessionError> {
        let prepared = self.prepare_process_request(request)?;
        let Some(job) = prepared.job else {
            return Ok(prepared.responses);
        };
        let result = run_bounded_process(
            &job.workspace_root,
            &job.command,
            &job.args,
            ProcessOptions {
                environment: &job.environment,
                stdin_bytes: &job.stdin,
                timeout: job.timeout,
                max_output_bytes: job.max_output_bytes,
                cancellation: Some(&job.cancellation),
            },
        );
        let mut responses = prepared.responses;
        responses.extend(self.complete_process_job(job, result)?);
        Ok(responses)
    }

    pub fn prepare_process_request(
        &mut self,
        request: v1::ProcessRequest,
    ) -> Result<PreparedProcess, SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        let workspace_root = self
            .workspace(&request.workspace_handle)?
            .root()
            .to_path_buf();
        let environment = process_environment(&request)?;
        if request.stdin.len() > 1024 * 1024 {
            return Err(SessionError::Process(
                "process stdin exceeds the configured 1 MiB limit".to_owned(),
            ));
        }
        let now = Instant::now();
        let request_digest = request.request_digest.clone();
        let accepted = self
            .process_operations
            .accept(request.operation_id.clone(), request.request_digest, now)
            .map_err(operation_error)?;
        if matches!(&accepted, AcceptResult::Accepted)
            && self.process_cancellations.len() >= MAX_CONCURRENT_PROCESS_OPERATIONS
        {
            self.process_operations
                .forget_accepted(&request.operation_id);
            return Err(SessionError::ResourceLimit(
                "concurrent process operation limit reached".to_owned(),
            ));
        }
        if matches!(&accepted, AcceptResult::Accepted) {
            if let Err(error) = self.append_process_journal(&JournalRecord::Accepted {
                operation_id: request.operation_id.clone(),
                request_digest,
            }) {
                self.process_operations
                    .forget_accepted(&request.operation_id);
                return Err(error);
            }
            self.append_process_retention(&request.operation_id)?;
        }
        let duplicate = matches!(accepted, AcceptResult::Duplicate(_));
        let mut responses = vec![v1::Frame {
            payload: Some(v1::frame::Payload::ProcessAccepted(v1::ProcessAccepted {
                request_id: request.request_id.clone(),
                operation_id: request.operation_id.clone(),
                accepted: true,
                duplicate,
                error_code: String::new(),
                error_message: String::new(),
            })),
        }];
        if let AcceptResult::Duplicate(snapshot) = accepted {
            let replay = self
                .process_operations
                .replay_from(&request.operation_id, 0, now)
                .map_err(|error| SessionError::ProcessReplay(error.to_string()))?;
            responses.extend(replay.into_iter().map(|chunk| {
                process_output_frame(
                    &request.operation_id,
                    chunk.sequence,
                    chunk.stream,
                    chunk.bytes,
                )
            }));
            if let Some(terminal) = snapshot.terminal {
                responses.push(process_completed_frame(
                    &request.request_id,
                    &request.operation_id,
                    &terminal,
                    false,
                ));
            }
            return Ok(PreparedProcess {
                responses,
                job: None,
            });
        }

        self.append_process_journal(&JournalRecord::Started {
            operation_id: request.operation_id.clone(),
        })?;
        self.process_operations
            .start(&request.operation_id, now)
            .map_err(operation_error)?;
        let max_output_bytes = request.max_output_bytes.min(8 * 1024 * 1024) as usize;
        let timeout = Duration::from_millis(request.timeout_ms.min(600_000));
        let cancellation = Arc::new(AtomicBool::new(false));
        self.process_cancellations
            .insert(request.operation_id.clone(), Arc::clone(&cancellation));
        Ok(PreparedProcess {
            responses,
            job: Some(ProcessJob {
                request_id: request.request_id,
                operation_id: request.operation_id,
                workspace_root,
                command: request.command,
                args: request.args,
                environment,
                stdin: request.stdin,
                timeout,
                max_output_bytes,
                cancellation,
            }),
        })
    }

    pub fn complete_process_job(
        &mut self,
        job: ProcessJob,
        result: Result<process::ProcessResult, process::ProcessError>,
    ) -> Result<Vec<v1::Frame>, SessionError> {
        self.complete_process_job_inner(job, result, true)
    }

    pub fn complete_streamed_process_job(
        &mut self,
        job: ProcessJob,
        result: Result<process::ProcessResult, process::ProcessError>,
    ) -> Result<Vec<v1::Frame>, SessionError> {
        self.complete_process_job_inner(job, result, false)
    }

    pub fn record_process_output(
        &mut self,
        operation_id: &str,
        stream: OutputStream,
        bytes: Vec<u8>,
    ) -> Result<v1::Frame, SessionError> {
        let sequence = self
            .process_operations
            .snapshot(operation_id, Instant::now())
            .map_err(operation_error)?
            .next_sequence;
        self.append_process_journal(&JournalRecord::Output {
            operation_id: operation_id.to_owned(),
            sequence,
            stream,
            bytes: bytes.clone(),
        })?;
        let sequence = self
            .process_operations
            .append_output(operation_id, stream, bytes.clone(), Instant::now())
            .map_err(operation_error)?;
        Ok(process_output_frame(operation_id, sequence, stream, bytes))
    }

    fn complete_process_job_inner(
        &mut self,
        job: ProcessJob,
        result: Result<process::ProcessResult, process::ProcessError>,
        emit_output: bool,
    ) -> Result<Vec<v1::Frame>, SessionError> {
        let operation_id = job.operation_id.clone();
        let completed = self.persist_process_job_result(job, result, emit_output);
        self.process_cancellations.remove(&operation_id);
        completed
    }

    fn persist_process_job_result(
        &mut self,
        job: ProcessJob,
        result: Result<process::ProcessResult, process::ProcessError>,
        emit_output: bool,
    ) -> Result<Vec<v1::Frame>, SessionError> {
        let mut responses = Vec::new();
        match result {
            Ok(result) => {
                if emit_output {
                    for (stream, bytes) in [
                        (OutputStream::Stdout, result.stdout),
                        (OutputStream::Stderr, result.stderr),
                    ] {
                        if bytes.is_empty() {
                            continue;
                        }
                        responses.push(self.record_process_output(
                            &job.operation_id,
                            stream,
                            bytes,
                        )?);
                    }
                }
                let (state, error_code) = if result.cancelled {
                    (OperationState::Cancelled, Some("CANCELLED".to_owned()))
                } else if result.timed_out {
                    (OperationState::Failed, Some("TIMEOUT".to_owned()))
                } else if result.exit_code == Some(0) {
                    (OperationState::Completed, None)
                } else {
                    (OperationState::Failed, Some("NONZERO_EXIT".to_owned()))
                };
                self.append_process_journal(&JournalRecord::Completed {
                    operation_id: job.operation_id.clone(),
                    state,
                    exit_code: result.exit_code,
                    error_code: error_code.clone(),
                })?;
                self.process_operations
                    .complete(
                        &job.operation_id,
                        state,
                        result.exit_code,
                        error_code,
                        Instant::now(),
                    )
                    .map_err(operation_error)?;
                self.append_process_retention(&job.operation_id)?;
                let terminal = self
                    .process_operations
                    .snapshot(&job.operation_id, Instant::now())
                    .map_err(operation_error)?
                    .terminal
                    .ok_or(SessionError::UnexpectedMessage)?;
                responses.push(process_completed_frame(
                    &job.request_id,
                    &job.operation_id,
                    &terminal,
                    result.output_truncated,
                ));
            }
            Err(error) => {
                let error_message = error.to_string();
                self.append_process_journal(&JournalRecord::Completed {
                    operation_id: job.operation_id.clone(),
                    state: OperationState::Failed,
                    exit_code: None,
                    error_code: Some("PROCESS_ERROR".to_owned()),
                })?;
                self.process_operations
                    .complete(
                        &job.operation_id,
                        OperationState::Failed,
                        None,
                        Some("PROCESS_ERROR".to_owned()),
                        Instant::now(),
                    )
                    .map_err(operation_error)?;
                self.append_process_retention(&job.operation_id)?;
                let terminal = self
                    .process_operations
                    .snapshot(&job.operation_id, Instant::now())
                    .map_err(operation_error)?
                    .terminal
                    .ok_or(SessionError::UnexpectedMessage)?;
                let mut response =
                    process_completed_frame(&job.request_id, &job.operation_id, &terminal, false);
                if let Some(v1::frame::Payload::ProcessCompleted(completed)) =
                    response.payload.as_mut()
                {
                    completed.error_message = error_message;
                }
                responses.push(response);
            }
        }
        Ok(responses)
    }

    pub fn handle_process_attach(
        &mut self,
        request: v1::ProcessAttachRequest,
    ) -> Result<Vec<v1::Frame>, SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        let chunks = self
            .process_operations
            .replay_from(
                &request.operation_id,
                request.after_sequence,
                Instant::now(),
            )
            .map_err(|error| SessionError::ProcessReplay(error.to_string()))?;
        let snapshot = self
            .process_operations
            .snapshot(&request.operation_id, Instant::now())
            .map_err(operation_error)?;
        let mut responses = vec![process_attach_response_frame(
            &request.request_id,
            &snapshot,
        )];
        responses.extend(
            chunks
                .into_iter()
                .map(|chunk| {
                    process_output_frame(
                        &request.operation_id,
                        chunk.sequence,
                        chunk.stream,
                        chunk.bytes,
                    )
                })
                .collect::<Vec<_>>(),
        );
        if let Some(terminal) = snapshot.terminal {
            responses.push(process_completed_frame(
                &request.request_id,
                &request.operation_id,
                &terminal,
                false,
            ));
        }
        Ok(responses)
    }

    pub(super) fn handle_process_output_ack(&mut self, request: v1::ProcessOutputAck) -> v1::Frame {
        let (accepted, error_code, error_message) = match self.process_operations.acknowledge(
            &request.operation_id,
            request.acknowledged_sequence,
            Instant::now(),
        ) {
            Ok(()) => match self.append_process_journal(&JournalRecord::Acknowledged {
                operation_id: request.operation_id.clone(),
                acknowledged_sequence: request.acknowledged_sequence,
            }) {
                Ok(()) => (true, String::new(), String::new()),
                Err(error) => (false, "PROCESS_ACK_ERROR".to_owned(), error.to_string()),
            },
            Err(error) => (false, "PROCESS_ACK_ERROR".to_owned(), error.to_string()),
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::ProcessAckResponse(
                v1::ProcessAckResponse {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    accepted,
                    error_code,
                    error_message,
                },
            )),
        }
    }

    fn append_process_journal(&self, record: &JournalRecord) -> Result<(), SessionError> {
        let Some(journal) = &self.process_journal else {
            return Ok(());
        };
        journal
            .append(record)
            .map_err(|error| SessionError::ProcessJournal(error.to_string()))
    }

    fn append_process_retention(&self, operation_id: &str) -> Result<(), SessionError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| SessionError::ProcessJournal("clock is before Unix epoch".to_owned()))?;
        self.append_process_journal(&JournalRecord::Retention {
            operation_id: operation_id.to_owned(),
            expires_at_unix_ms: now.as_millis() as u64
                + PROCESS_RESULT_RETENTION.as_millis() as u64,
        })
    }
}
