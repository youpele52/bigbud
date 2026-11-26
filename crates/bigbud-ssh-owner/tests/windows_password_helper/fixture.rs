use super::HELPER;
use bigbud_ssh_owner::windows_password_gate::{
    PasswordBytes, ProbeQualification, TargetGeneration,
    native::{Admission, PasswordHelperAttempt, PasswordHelperBootstrap},
};
use std::{
    ffi::{OsStr, c_void},
    fs::File,
    io::{self, Read},
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING, PIPE_ACCESS_INBOUND,
        SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    },
    System::{
        Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS},
        Threading::{
            CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
            InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
            STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

const FIXTURE: &[u8] = b"public-synthetic-helper-executable-fixture";
const TARGET: TargetGeneration<'_> = TargetGeneration {
    target: "isolated-target",
    generation: 1,
};
const IO: Duration = Duration::from_secs(2);

#[test]
fn actual_helper_delivers_only_to_the_verified_synthetic_parent() {
    let ssh_image = std::env::current_exe().unwrap();
    let (mut attempt, mut endpoint, token) =
        PasswordHelperAttempt::register(TARGET, Path::new(HELPER)).unwrap();
    let bootstrap = PasswordHelperBootstrap::prepare(endpoint.name(), token).unwrap();
    let io_null = open_inheritable(&wide("NUL")).unwrap();
    let ssh_fixture = spawn(
        &ssh_image,
        "--exact fixture::ssh_standin --quiet",
        bootstrap.env_value(),
        bootstrap.owner_handle().as_raw_handle(),
        io_null.as_raw_handle(),
    )
    .unwrap();
    drop(bootstrap);
    attempt
        .bind_child(TARGET, ssh_fixture.0.as_handle(), &ssh_image)
        .unwrap();
    let request = endpoint.receive(IO).unwrap();
    let Admission::Claimed { reply, .. } = attempt.admit(TARGET, request) else {
        panic!("the standalone helper did not obtain its one-shot claim");
    };
    attempt
        .deliver(
            TARGET,
            reply,
            ProbeQualification {
                dedicated_owner_probe: true,
                fresh_connection: true,
                strict_host_verification: true,
                no_master_or_agent_reuse: true,
                password_only_without_fallback: true,
            },
            PasswordBytes::from_boxed_slice(FIXTURE.into()),
        )
        .unwrap();
    assert_eq!(ssh_fixture.exit().unwrap(), 0);
}

#[test]
fn ssh_standin() {
    let Ok(value) = std::env::var(PasswordHelperBootstrap::ENV) else {
        return;
    };
    let (owner_locator, raw) = value.rsplit_once(':').unwrap();
    let (name, _) = owner_locator.split_once(':').unwrap();
    let inherited_owner = usize::from_str_radix(raw, 16).unwrap() as HANDLE;
    let stdout_name = wide(format!("{name}-fixture-stdout"));
    // SAFETY: local, unique test pipe with a valid name and no security override.
    let raw = unsafe {
        CreateNamedPipeW(
            stdout_name.as_ptr(),
            PIPE_ACCESS_INBOUND,
            PIPE_REJECT_REMOTE_CLIENTS,
            1,
            0,
            4096,
            0,
            ptr::null(),
        )
    };
    assert_ne!(raw, INVALID_HANDLE_VALUE);
    // SAFETY: fresh successful CreateNamedPipeW result.
    let reader = File::from(unsafe { OwnedHandle::from_raw_handle(raw) });
    let writer = open_inheritable(&stdout_name).unwrap();
    // SAFETY: the same process already opened the client. Connect must report
    // ERROR_PIPE_CONNECTED or succeed, never block waiting for a client.
    let connected = unsafe { ConnectNamedPipe(reader.as_raw_handle(), ptr::null_mut()) };
    assert!(
        connected != 0
            || io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32)
    );
    let helper = spawn(
        Path::new(HELPER),
        "\"synthetic opaque prompt\"",
        &value,
        inherited_owner,
        writer.as_raw_handle(),
    )
    .unwrap();
    drop(writer);
    assert_eq!(helper.exit().unwrap(), 0);
    let mut line = Vec::new();
    reader.take(1026).read_to_end(&mut line).unwrap();
    assert_eq!(line.strip_suffix(b"\n"), Some(FIXTURE));
}

fn spawn(
    image: &Path,
    args: &str,
    value: &str,
    inherited_owner: HANDLE,
    stdout: HANDLE,
) -> io::Result<Process> {
    let program = wide(image.as_os_str());
    let mut command = vec![u16::from(b'"')];
    command.extend(image.as_os_str().encode_wide());
    command.extend(format!("\" {args}").encode_utf16().chain(Some(0)));
    let env: Vec<u16> = format!("{}={value}", PasswordHelperBootstrap::ENV)
        .encode_utf16()
        .chain([0, 0])
        .collect();
    let handles = [inherited_owner, stdout];
    let mut bytes = 0;
    // SAFETY: the null first-call buffer queries exact required size.
    unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut bytes) };
    if bytes == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let list = storage.as_mut_ptr().cast();
    // SAFETY: aligned writable storage is large enough for the queried list.
    checked(unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut bytes) })?;
    let attributes = Attributes(list);
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdout;
    startup.StartupInfo.hStdOutput = stdout;
    startup.StartupInfo.hStdError = stdout;
    startup.lpAttributeList = attributes.0;
    // SAFETY: the initialized list and handle array live through CreateProcessW.
    checked(unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of_val(&handles),
            ptr::null_mut(),
            ptr::null(),
        )
    })?;
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: strings/environment and startup data are properly terminated and
    // valid for the call. Only the two explicit handles can be inherited.
    checked(unsafe {
        CreateProcessW(
            program.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            env.as_ptr().cast::<c_void>(),
            ptr::null(),
            &startup.StartupInfo,
            &mut process,
        )
    })?;
    // SAFETY: the two successful process/thread results are separately owned.
    unsafe {
        drop(OwnedHandle::from_raw_handle(process.hThread));
        Ok(Process(OwnedHandle::from_raw_handle(process.hProcess)))
    }
}

struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: list was initialized exactly once and its backing storage lives.
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}

struct Process(OwnedHandle);
impl Process {
    fn exited(&self, ms: u32) -> bool {
        // SAFETY: live owned process handle.
        unsafe { WaitForSingleObject(self.0.as_raw_handle(), ms) == WAIT_OBJECT_0 }
    }
    fn exit(&self) -> io::Result<u32> {
        if !self.exited(5000) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "test child exceeded its deadline",
            ));
        }
        let mut code = 0;
        // SAFETY: live owned process handle and writable output slot.
        checked(unsafe { GetExitCodeProcess(self.0.as_raw_handle(), &mut code) })?;
        Ok(code)
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if !self.exited(0) {
            // SAFETY: this is the test's own child and delegated cleanup.
            if unsafe { TerminateProcess(self.0.as_raw_handle(), 1) } != 0 {
                let _ = self.exited(2000);
            }
        }
    }
}

fn open_inheritable(name: &[u16]) -> io::Result<OwnedHandle> {
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: local terminated name and live initialized security attributes.
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_GENERIC_WRITE
                | if name == wide("NUL") {
                    FILE_GENERIC_READ
                } else {
                    0
                },
            0,
            &security,
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: success returns a new owned file handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn checked(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
