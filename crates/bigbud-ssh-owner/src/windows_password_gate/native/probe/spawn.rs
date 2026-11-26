//! Windows-only suspended, job-contained launch. No shell or ambient env.
use super::{PasswordHelperBootstrap, denied, recipe::Recipe};
use std::{
    ffi::{OsStr, c_void},
    io,
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr,
    sync::mpsc::{self, Sender},
    thread::{self, JoinHandle},
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    },
    System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
        DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION,
        ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute,
        WaitForSingleObject,
    },
};

mod job;

pub(super) struct Suspended {
    job: OwnedHandle,
    process: OwnedHandle,
    thread: OwnedHandle,
}

impl Suspended {
    pub(super) fn spawn(recipe: &Recipe, bootstrap: &PasswordHelperBootstrap) -> io::Result<Self> {
        let system_root = recipe.system.parent().ok_or_else(denied)?;
        let helper = recipe.helper.dos_path().as_os_str();
        let program = wide(recipe.ssh.dos_path().as_os_str());
        let dir = wide(recipe.system.as_os_str());
        let env = environment(
            system_root,
            helper,
            bootstrap.env_value(),
            #[cfg(test)]
            recipe.omit_askpass_trigger,
        );
        let command = std::iter::once(recipe.ssh.dos_path().as_os_str())
            .chain(recipe.args.iter().map(|arg| arg.as_os_str()));
        let mut command = command_line(command)?;
        let job = job::kill_on_close()?;
        let null = inheritable_null()?;
        let handles = [
            bootstrap.owner_handle().as_raw_handle(),
            null.as_raw_handle(),
        ];
        let jobs = [job.as_raw_handle()];
        let attrs = Attributes::new()?;
        attrs.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
        attrs.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
        let mut start = STARTUPINFOEXW::default();
        start.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        start.StartupInfo.hStdInput = null.as_raw_handle();
        start.StartupInfo.hStdOutput = null.as_raw_handle();
        start.StartupInfo.hStdError = null.as_raw_handle();
        start.lpAttributeList = attrs.raw();
        let mut child = PROCESS_INFORMATION::default();
        // SAFETY: terminated args/environment, stable buffers for the two
        // attributes, and exclusive process-info output. Kernel assigns the
        // suspended child to the kill-on-close job atomically with creation.
        ok(unsafe {
            CreateProcessW(
                program.as_ptr(),
                command.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_NO_WINDOW
                    | CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                env.as_ptr().cast::<c_void>(),
                dir.as_ptr(),
                &start.StartupInfo,
                &mut child,
            )
        })?;
        // SAFETY: CreateProcessW succeeded and transferred these handles.
        let (process, thread) = unsafe {
            (
                OwnedHandle::from_raw_handle(child.hProcess),
                OwnedHandle::from_raw_handle(child.hThread),
            )
        };
        Ok(Self {
            job,
            process,
            thread,
        })
    }

    pub(super) fn process(&self) -> BorrowedHandle<'_> {
        self.process.as_handle()
    }

    pub(super) fn resume(self, deadline: Instant) -> io::Result<Active> {
        let Self {
            job,
            process,
            thread,
        } = self;
        let (stop, cancelled) = mpsc::channel();
        let watchdog = thread::Builder::new()
            .name("ssh-password-probe-deadline".into())
            .spawn(move || {
                // Both expiry and cancellation drop the only job handle, which
                // terminates SSH and any nested helper even if the owner is idle.
                let _ = cancelled.recv_timeout(deadline.saturating_duration_since(Instant::now()));
                drop(job);
            })?;
        let active = Active {
            process,
            stop: Some(stop),
            watchdog: Some(watchdog),
        };
        if Instant::now() >= deadline {
            return Err(denied());
        }
        // SAFETY: retained private primary thread of the suspended child.
        if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
            return Err(denied());
        }
        Ok(active)
    }
}

pub(super) struct Active {
    process: OwnedHandle,
    stop: Option<Sender<()>>,
    watchdog: Option<JoinHandle<()>>,
}

impl Active {
    pub(super) fn running(&self) -> bool {
        // SAFETY: retained process handle; a zero-time wait never blocks.
        unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) == WAIT_TIMEOUT }
    }
    #[cfg(test)]
    pub(super) fn wait_for_exit(&self, timeout: std::time::Duration) -> io::Result<u32> {
        wait_for_exit(&self.process, timeout)
    }

    #[cfg(test)]
    pub(super) fn clone_process(&self) -> io::Result<OwnedHandle> {
        self.process.try_clone()
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(watchdog) = self.watchdog.take() {
            // Channel disconnect wakes the only waiter. Even if it panicked,
            // its owned job handle closed; the caller cannot reuse this child.
            let _ = watchdog.join();
        }
    }
}

struct Attributes {
    _memory: Vec<usize>,
    ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut size = 0;
        // SAFETY: null buffer queries the required byte count only.
        let _ = unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 2, 0, &mut size) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut memory = vec![0usize; size.div_ceil(size_of::<usize>())];
        let ptr = memory.as_mut_ptr().cast();
        // SAFETY: sufficient aligned backing bytes per the native size query.
        ok(unsafe { InitializeProcThreadAttributeList(ptr, 2, 0, &mut size) })?;
        Ok(Self {
            _memory: memory,
            ptr,
        })
    }

    fn add(&self, kind: u32, handles: &[HANDLE]) -> io::Result<()> {
        // SAFETY: the borrowed handle arrays and their handles outlive this
        // private list's only use, in its caller's synchronous launch.
        ok(unsafe {
            UpdateProcThreadAttribute(
                self.ptr,
                0,
                kind as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                ptr::null_mut(),
                ptr::null(),
            )
        })
    }

    fn raw(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.ptr
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: initialized list and live allocation until this destructor returns.
        unsafe { DeleteProcThreadAttributeList(self.ptr) };
    }
}

fn inheritable_null() -> io::Result<OwnedHandle> {
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let path = wide(OsStr::new("NUL"));
    // SAFETY: fixed NUL device name, initialized attributes, no template.
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &security,
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateFileW transferred the file handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn environment(
    root: &Path,
    helper: &OsStr,
    bootstrap: &str,
    #[cfg(test)] omit_askpass_trigger: Option<&str>,
) -> Vec<u16> {
    const ENV: &str = PasswordHelperBootstrap::ENV;
    let mut result = Vec::new();
    for (name, value) in [
        (ENV, OsStr::new(bootstrap)),
        ("DISPLAY", OsStr::new("bigbud:0")),
        ("SSH_ASKPASS", helper),
        ("SSH_ASKPASS_REQUIRE", OsStr::new("force")),
        ("SystemRoot", root.as_os_str()),
    ] {
        #[cfg(test)]
        if omit_askpass_trigger == Some(name) {
            continue;
        }
        result.extend(
            name.encode_utf16()
                .chain(Some(u16::from(b'=')))
                .chain(value.encode_wide())
                .chain(Some(0)),
        );
    }
    result.push(0);
    result
}

fn command_line<'a>(args: impl IntoIterator<Item = &'a OsStr>) -> io::Result<Vec<u16>> {
    // All arguments are built from guarded paths, fixed flags, a validated
    // user, and a port. Windows still requires CRT-compatible quote escaping.
    const QUOTE: u16 = b'"' as u16;
    const SLASH: u16 = b'\\' as u16;
    let mut result = Vec::new();
    for arg in args {
        if !result.is_empty() {
            result.push(b' ' as u16);
        }
        result.push(QUOTE);
        let mut slashes = 0;
        for ch in arg.encode_wide() {
            match ch {
                0 => return Err(denied()),
                SLASH => {
                    slashes += 1;
                }
                _ => {
                    result.extend(std::iter::repeat_n(
                        SLASH,
                        if ch == QUOTE {
                            2 * slashes + 1
                        } else {
                            slashes
                        },
                    ));
                    result.push(ch);
                    slashes = 0;
                }
            }
        }
        result.extend(std::iter::repeat_n(SLASH, 2 * slashes));
        result.push(QUOTE);
    }
    result.push(0);
    Ok(result)
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn ok(success: i32) -> io::Result<()> {
    if success != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
pub(super) fn wait_for_exit(
    process: &OwnedHandle,
    timeout: std::time::Duration,
) -> io::Result<u32> {
    use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::GetExitCodeProcess};
    // SAFETY: live process handle and bounded test wait.
    if unsafe { WaitForSingleObject(process.as_raw_handle(), timeout.as_millis() as u32) }
        != WAIT_OBJECT_0
    {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "test Windows probe did not exit",
        ));
    }
    let mut status = 0;
    // SAFETY: retained exited process handle and writable exit status.
    ok(unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut status) })?;
    Ok(status)
}

#[cfg(test)]
mod tests;
