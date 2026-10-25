use super::*;

impl PtyHandle {
    #[cfg(unix)]
    pub fn spawn(
        id: String,
        cwd: &Path,
        shell: &str,
        args: &[String],
        cols: u16,
        rows: u16,
        environment: &[(String, String)],
    ) -> Result<PtyJob, PtyError> {
        if id.is_empty() {
            return Err(PtyError::MissingId);
        }
        if shell.is_empty() {
            return Err(PtyError::MissingShell);
        }
        let shell = std::ffi::CString::new(shell).map_err(|_| {
            PtyError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "shell contains NUL",
            ))
        })?;
        let executable = if shell.as_bytes().first() == Some(&b'/') {
            shell.clone()
        } else {
            std::ffi::CString::new(format!("/bin/{}", shell.to_string_lossy())).map_err(|_| {
                PtyError::Io(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "shell contains an invalid path",
                ))
            })?
        };
        let args = args
            .iter()
            .map(|arg| {
                std::ffi::CString::new(arg.as_str()).map_err(|_| {
                    PtyError::Io(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "argument contains NUL",
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let cwd = std::ffi::CString::new(cwd.as_os_str().as_encoded_bytes()).map_err(|_| {
            PtyError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cwd contains NUL",
            ))
        })?;
        let environment = super::environment::remote_environment(environment)?;
        let environment = environment
            .iter()
            .map(|(name, value)| {
                let mut entry = name.as_bytes().to_vec();
                entry.push(b'=');
                entry.extend_from_slice(value.as_bytes());
                std::ffi::CString::new(entry).map_err(|_| {
                    PtyError::Io(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "environment entry contains NUL",
                    ))
                })
            })
            .collect::<Result<Vec<_>, PtyError>>()?;
        let mut argv = Vec::with_capacity(args.len() + 2);
        argv.push(shell.as_ptr());
        argv.extend(args.iter().map(|arg| arg.as_ptr()));
        argv.push(std::ptr::null());
        let mut envpointers = environment
            .iter()
            .map(|entry| entry.as_ptr())
            .collect::<Vec<_>>();
        envpointers.push(std::ptr::null());

        let mut master_fd = -1;
        let window = libc::winsize {
            ws_row: rows.max(1),
            ws_col: cols.max(1),
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let mut reservation = cleanup::Reservation::reserve().map_err(PtyError::Io)?;
        let spawn_gate = crate::spawn_gate::lock().map_err(PtyError::Io)?;
        // SAFETY: all argv/env/cwd storage is preallocated and outlives fork. Child
        // uses only chdir/execve/_exit (no Rust allocation/locks/unwind after fork).
        let pid = unsafe {
            libc::forkpty(
                &mut master_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &window as *const libc::winsize as *mut libc::winsize,
            )
        };
        if pid < 0 {
            return Err(PtyError::Io(io::Error::last_os_error()));
        }
        if pid == 0 {
            // SAFETY: valid NUL-terminated pointers were prepared before fork;
            // failure cannot continue the shell in an unintended directory.
            unsafe {
                if libc::chdir(cwd.as_ptr()) != 0 {
                    libc::_exit(126);
                }
                libc::execve(executable.as_ptr(), argv.as_ptr(), envpointers.as_ptr());
                libc::_exit(127);
            }
        }

        let child = Arc::new(child::Child::new(pid));
        reservation
            .retain(Arc::clone(&child))
            .map_err(PtyError::Io)?;
        let master = platform::configure_master(master_fd, spawn_gate).map_err(PtyError::Io)?;
        let reader = master.try_clone().map_err(PtyError::Io)?;
        let mut input_fd = master.try_clone().map_err(PtyError::Io)?;
        let input = input::InputWriter::start(
            format!("{pid}/{}", master.as_raw_fd()).into_bytes(),
            move |bytes| std::io::Write::write(&mut input_fd, bytes),
        )
        .map_err(PtyError::Io)?;
        let handle = Arc::new(Self {
            id,
            pid: pid as u32,
            inner: Arc::new(PtyInner {
                master: Mutex::new(Some(master)),
                child,
                input,
                state: Mutex::new(PtyStateRecord {
                    state: PtyState::Running,
                    next_sequence: 1,
                    first_retained_sequence: 1,
                    retained_bytes: 0,
                    output: VecDeque::new(),
                    exit_code: None,
                    signal: None,
                }),
            }),
        });
        reservation.transfer();
        Ok(PtyJob { handle, reader })
    }

    #[cfg(not(unix))]
    pub fn spawn(
        _id: String,
        _cwd: &Path,
        _shell: &str,
        _args: &[String],
        _cols: u16,
        _rows: u16,
        _environment: &[(String, String)],
    ) -> Result<PtyJob, PtyError> {
        Err(PtyError::Unsupported)
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
