use super::*;

impl PtyHandle {
    /// Running is the legacy job lifecycle, not proof of final exec/identity.
    #[cfg(unix)]
    pub fn launch_outcome(&self) -> LaunchOutcome {
        self.inner.launch_outcome
    }

    #[cfg(unix)]
    pub fn write_input(&self, sequence: u64, bytes: &[u8]) -> Result<bool, PtyError> {
        if self.snapshot()?.state != PtyState::Running {
            return Err(PtyError::InputFenced);
        }
        let admitted = self.inner.input.submit(sequence, bytes)?;
        match self.inner.input.wait(sequence)? {
            InputOutcome::Written(_) => Ok(admitted),
            _ => Err(PtyError::InputFenced),
        }
    }

    #[cfg(unix)]
    pub fn input_status(&self, sequence: u64) -> Result<InputOutcome, PtyError> {
        self.inner.input.status(sequence)
    }

    #[cfg(not(unix))]
    pub fn write_input(&self, _sequence: u64, _bytes: &[u8]) -> Result<bool, PtyError> {
        Err(PtyError::Unsupported)
    }

    #[cfg(unix)]
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        let window = libc::winsize {
            ws_row: rows.max(1),
            ws_col: cols.max(1),
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let master = self.inner.master.lock().map_err(|_| poisoned())?;
        let master = master.as_ref().ok_or(PtyError::Unknown)?;
        // SAFETY: master is owned/live and window has the exact ioctl winsize layout.
        let result = unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &window) };
        if result == -1 {
            return Err(PtyError::Io(io::Error::last_os_error()));
        }
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn resize(&self, _cols: u16, _rows: u16) -> Result<(), PtyError> {
        Err(PtyError::Unsupported)
    }

    pub fn signal(&self, signal: &str) -> Result<(), PtyError> {
        #[cfg(unix)]
        {
            let value = match signal {
                "SIGTERM" => libc::SIGTERM,
                "SIGKILL" => libc::SIGKILL,
                "SIGHUP" => libc::SIGHUP,
                "SIGINT" => libc::SIGINT,
                _ => {
                    return Err(PtyError::Io(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unsupported signal",
                    )));
                }
            };
            self.inner.child.signal(value).map_err(PtyError::Io)
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            Err(PtyError::Unsupported)
        }
    }

    /// Force termination is reserved for the restart fence after graceful
    /// termination has exceeded its bounded wait.
    pub fn force_kill(&self) -> Result<(), PtyError> {
        self.signal("SIGKILL")
    }

    /// UI/input close is not evidence that the exclusively owned child was reaped.
    pub fn child_reaped(&self) -> bool {
        #[cfg(unix)]
        {
            self.inner.child.reaped()
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    pub fn native_settled(&self) -> bool {
        #[cfg(unix)]
        {
            self.child_reaped() && self.inner.input.finished()
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    #[cfg(unix)]
    pub fn append_output(&self, bytes: Vec<u8>) -> Result<PtyOutputChunk, PtyError> {
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        if state.state == PtyState::Closed {
            return Err(PtyError::Unknown);
        }
        let sequence = state.next_sequence;
        state.next_sequence = state
            .next_sequence
            .checked_add(1)
            .ok_or(PtyError::InvalidAcknowledgement)?;
        state.retained_bytes += bytes.len();
        let chunk = PtyOutputChunk { sequence, bytes };
        state.output.push_back(chunk.clone());
        while state.retained_bytes > MAX_OUTPUT_BYTES || state.output.len() > 4096 {
            let Some(oldest) = state.output.pop_front() else {
                break;
            };
            state.retained_bytes -= oldest.bytes.len();
            state.first_retained_sequence = oldest.sequence + 1;
        }
        Ok(chunk)
    }

    #[cfg(not(unix))]
    pub fn append_output(&self, _bytes: Vec<u8>) -> Result<PtyOutputChunk, PtyError> {
        Err(PtyError::Unsupported)
    }

    #[cfg(unix)]
    pub fn acknowledge(&self, sequence: u64) -> Result<(), PtyError> {
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        // Legacy ACK has always been a global retention cursor, not a per-view
        // parser/durable ACK. Do not reinterpret stale acknowledgements here.
        if sequence >= state.next_sequence {
            return Err(PtyError::InvalidAcknowledgement);
        }
        while state
            .output
            .front()
            .is_some_and(|chunk| chunk.sequence <= sequence)
        {
            let Some(chunk) = state.output.pop_front() else {
                break;
            };
            state.retained_bytes -= chunk.bytes.len();
            state.first_retained_sequence = chunk.sequence + 1;
        }
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn acknowledge(&self, _sequence: u64) -> Result<(), PtyError> {
        Err(PtyError::Unsupported)
    }

    #[cfg(unix)]
    pub fn replay(&self, after_sequence: u64) -> Result<Vec<PtyOutputChunk>, PtyError> {
        let state = self.inner.state.lock().map_err(|_| poisoned())?;
        if after_sequence >= state.next_sequence {
            return Err(PtyError::InvalidAcknowledgement);
        }
        if after_sequence.saturating_add(1) < state.first_retained_sequence {
            return Err(PtyError::ReplayGap {
                first_retained_sequence: state.first_retained_sequence,
            });
        }
        Ok(state
            .output
            .iter()
            .filter(|chunk| chunk.sequence > after_sequence)
            .cloned()
            .collect())
    }

    #[cfg(not(unix))]
    pub fn replay(&self, _after_sequence: u64) -> Result<Vec<PtyOutputChunk>, PtyError> {
        Err(PtyError::Unsupported)
    }

    #[cfg(unix)]
    pub fn snapshot(&self) -> Result<PtySnapshot, PtyError> {
        let state = self.inner.state.lock().map_err(|_| poisoned())?;
        Ok(PtySnapshot {
            state: state.state,
            pid: self.pid,
            next_sequence: state.next_sequence,
            first_retained_sequence: state.first_retained_sequence,
            exit_code: state.exit_code,
            signal: state.signal,
        })
    }

    #[cfg(not(unix))]
    pub fn snapshot(&self) -> Result<PtySnapshot, PtyError> {
        Err(PtyError::Unsupported)
    }

    #[cfg(unix)]
    pub fn mark_exited(&self, exit_code: Option<i32>, signal: Option<i32>) -> Result<(), PtyError> {
        if !self.child_reaped() {
            return Err(PtyError::Io(io::Error::other("PTY exit not verified")));
        }
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        if state.state != PtyState::Closed {
            state.state = PtyState::Exited;
        }
        state.exit_code = exit_code;
        state.signal = signal;
        drop(state);
        self.inner.input.cancel();
        drop(self.inner.master.lock().map_err(|_| poisoned())?.take());
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn mark_exited(
        &self,
        _exit_code: Option<i32>,
        _signal: Option<i32>,
    ) -> Result<(), PtyError> {
        Err(PtyError::Unsupported)
    }

    #[cfg(unix)]
    pub fn close(&self, terminate: bool) -> Result<(), PtyError> {
        if terminate {
            self.signal("SIGTERM")?;
        }
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        state.state = PtyState::Closed;
        drop(state);
        self.inner.input.shutdown()?;
        drop(self.inner.master.lock().map_err(|_| poisoned())?.take());
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn close(&self, _terminate: bool) -> Result<(), PtyError> {
        Err(PtyError::Unsupported)
    }
}
