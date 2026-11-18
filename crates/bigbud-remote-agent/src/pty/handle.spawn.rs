use super::*;
#[cfg(unix)]
use std::os::fd::{FromRawFd, IntoRawFd};

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
        let mut reservation = cleanup::Reservation::reserve(&id).map_err(PtyError::Io)?;
        let spawn_gate = crate::spawn_gate::lock().map_err(PtyError::Io)?;
        let receipt = launch::Receipt::new().map_err(PtyError::Io)?;
        let receipt_reader = receipt.reader.as_raw_fd();
        let receipt_writer = receipt.writer.as_raw_fd();
        // SAFETY: all argv/env/cwd storage is preallocated and outlives fork. Child
        // uses only async-signal-safe libc operations; no allocation/locks/unwind.
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
                libc::close(receipt_reader);
                if libc::chdir(cwd.as_ptr()) != 0 {
                    launch::fail(receipt_writer, LaunchStage::Chdir, launch::errno_value());
                }
                libc::execve(executable.as_ptr(), argv.as_ptr(), envpointers.as_ptr());
                launch::fail(receipt_writer, LaunchStage::Exec, launch::errno_value());
            }
        }

        // SAFETY: successful forkpty returned one owned master. Adopt it before
        // any fallible post-fork work, including retaining cleanup authority.
        let master = unsafe { std::fs::File::from_raw_fd(master_fd) };
        let child = Arc::new(child::Child::new(pid));
        reservation
            .retain(Arc::clone(&child))
            .map_err(PtyError::Io)?;
        drop(receipt.writer);
        let master =
            platform::configure_master(master.into_raw_fd(), spawn_gate).map_err(PtyError::Io)?;
        // Never wait with the shared spawn gate held. Failed/unknown setup leaves
        // the reservation owning the child; it does not authorize retry/fallback.
        let launch_outcome = launch::receive(receipt.reader, launch::TIMEOUT)?;
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
                launch_outcome,
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
}
