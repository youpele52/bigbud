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
        let environment = environment
            .iter()
            .map(|(name, value)| {
                let name = std::ffi::CString::new(name.as_str()).map_err(|_| {
                    PtyError::Io(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "environment name contains NUL",
                    ))
                })?;
                let value = std::ffi::CString::new(value.as_str()).map_err(|_| {
                    PtyError::Io(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "environment value contains NUL",
                    ))
                })?;
                Ok((name, value))
            })
            .collect::<Result<Vec<_>, PtyError>>()?;

        let mut master_fd = -1;
        let window = libc::winsize {
            ws_row: rows.max(1),
            ws_col: cols.max(1),
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
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
            unsafe {
                libc::chdir(cwd.as_ptr());
                let mut argv = Vec::with_capacity(args.len() + 2);
                argv.push(shell.as_ptr());
                argv.extend(args.iter().map(|arg| arg.as_ptr()));
                argv.push(std::ptr::null());
                let envp = environment
                    .iter()
                    .map(|(name, value)| {
                        let mut entry = name.as_bytes().to_vec();
                        entry.push(b'=');
                        entry.extend_from_slice(value.as_bytes());
                        std::ffi::CString::new(entry).expect("validated environment entry")
                    })
                    .collect::<Vec<_>>();
                let mut envpointers = envp.iter().map(|entry| entry.as_ptr()).collect::<Vec<_>>();
                envpointers.push(std::ptr::null());
                libc::execve(executable.as_ptr(), argv.as_ptr(), envpointers.as_ptr());
                libc::_exit(127);
            }
        }

        let master = unsafe { std::fs::File::from_raw_fd(master_fd) };
        let reader = master.try_clone().map_err(PtyError::Io)?;
        let handle = Arc::new(Self {
            id,
            pid: pid as u32,
            inner: Arc::new(PtyInner {
                master: Mutex::new(master),
                state: Mutex::new(PtyStateRecord {
                    state: PtyState::Running,
                    next_sequence: 1,
                    first_retained_sequence: 1,
                    retained_bytes: 0,
                    output: VecDeque::new(),
                    last_input_sequence: 0,
                    exit_code: None,
                    signal: None,
                }),
            }),
        });
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
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(PtyError::InputLimit);
        }
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        if sequence <= state.last_input_sequence {
            return Ok(false);
        }
        let expected = state.last_input_sequence + 1;
        if sequence != expected {
            return Err(PtyError::InputSequence {
                expected,
                actual: sequence,
            });
        }
        if state.state != PtyState::Running {
            return Ok(false);
        }
        self.inner
            .master
            .lock()
            .map_err(|_| poisoned())?
            .write_all(bytes)
            .map_err(PtyError::Io)?;
        state.last_input_sequence = sequence;
        Ok(true)
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
            let result = unsafe { libc::kill(-(self.pid as i32), value) };
            if result == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(PtyError::Io(error));
                }
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            Err(PtyError::Unsupported)
        }
    }

    pub fn append_output(&self, bytes: Vec<u8>) -> Result<PtyOutputChunk, PtyError> {
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        if state.state == PtyState::Closed {
            return Err(PtyError::Unknown);
        }
        let sequence = state.next_sequence;
        state.next_sequence += 1;
        state.retained_bytes += bytes.len();
        let chunk = PtyOutputChunk { sequence, bytes };
        state.output.push_back(chunk.clone());
        while state.retained_bytes > MAX_OUTPUT_BYTES {
            let Some(oldest) = state.output.pop_front() else {
                break;
            };
            state.retained_bytes -= oldest.bytes.len();
            state.first_retained_sequence = oldest.sequence + 1;
        }
        Ok(chunk)
    }

    pub fn acknowledge(&self, sequence: u64) -> Result<(), PtyError> {
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        if sequence >= state.next_sequence {
            return Err(PtyError::InvalidAcknowledgement);
        }
        while let Some(chunk) = state.output.front() {
            if chunk.sequence > sequence {
                break;
            }
            let chunk = state.output.pop_front().expect("front was present");
            state.retained_bytes -= chunk.bytes.len();
            state.first_retained_sequence = chunk.sequence + 1;
        }
        Ok(())
    }

    pub fn replay(&self, after_sequence: u64) -> Result<Vec<PtyOutputChunk>, PtyError> {
        let state = self.inner.state.lock().map_err(|_| poisoned())?;
        if after_sequence + 1 < state.first_retained_sequence {
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

    pub fn mark_exited(&self, exit_code: Option<i32>, signal: Option<i32>) -> Result<(), PtyError> {
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        if state.state != PtyState::Closed {
            state.state = PtyState::Exited;
            state.exit_code = exit_code;
            state.signal = signal;
        }
        Ok(())
    }

    pub fn close(&self, terminate: bool) -> Result<(), PtyError> {
        if terminate {
            self.signal("SIGTERM")?;
        }
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        state.state = PtyState::Closed;
        Ok(())
    }
}
