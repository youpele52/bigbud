#[cfg(any(test, target_os = "linux"))]
use super::super::Transport;
use super::super::{PrivatePaths, UNAVAILABLE, paths, probe};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::{PASSWORD_CAP, valid_password};
use super::{Secret, process};
use crate::v1::ErrorCode;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::{env, process::ExitCode};
use std::{
    ffi::OsStr,
    fs, io,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};

const SOCKET: &str = "BIGBUD_POSIX_PASSWORD_SOCKET";
const PROMPT: &str = "BIGBUD_POSIX_PASSWORD_PROMPT";
const EXPECTED_OWNER: &str = "BIGBUD_POSIX_PASSWORD_OWNER";

pub(super) struct Listener {
    path: PathBuf,
    endpoint: Option<(UnixListener, (u64, u64))>,
    owner: u32,
    image_path: PathBuf,
    image: process::Image,
}

impl Listener {
    pub(super) fn new(paths: &PrivatePaths) -> Result<Self, ErrorCode> {
        let (image_path, image) = process::helper_image()?;
        let path = paths.askpass_path()?;
        let listener = UnixListener::bind(&path).map_err(|_| UNAVAILABLE)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|_| UNAVAILABLE)?;
        let stamp = observe_endpoint(&path)?;
        let mut result = Self {
            path,
            endpoint: Some((listener, stamp)),
            owner: std::process::id(),
            image_path,
            image,
        };
        let Some((listener, _)) = &result.endpoint else {
            return Err(UNAVAILABLE);
        };
        if listener.set_nonblocking(true).is_err() {
            result.close(paths)?;
            return Err(UNAVAILABLE);
        }
        Ok(result)
    }

    #[cfg(any(test, target_os = "linux"))]
    pub(super) fn configure(
        &self,
        command: &mut Command,
        transport: &Transport,
    ) -> Result<(), ErrorCode> {
        let prompt = format!(
            "{}@{}'s password: ",
            transport.config.user,
            transport.host()
        );
        self.configure_prompt(command, OsStr::new(&prompt))
    }

    /// The exact prompt OpenSSH will pass the helper; any other prompt (OTP,
    /// keyboard-interactive, confirmation) makes the helper refuse (U2).
    pub(super) fn configure_prompt(
        &self,
        command: &mut Command,
        prompt: &OsStr,
    ) -> Result<(), ErrorCode> {
        if process::Image::at(&self.image_path)? != self.image {
            return Err(UNAVAILABLE);
        }
        command
            .env("SSH_ASKPASS", &self.image_path)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env(SOCKET, &self.path)
            .env(PROMPT, prompt)
            .env(EXPECTED_OWNER, self.owner.to_string());
        Ok(())
    }

    pub(super) fn accept(&self, ssh: u32) -> Result<Option<UnixStream>, ErrorCode> {
        let Some((listener, _)) = &self.endpoint else {
            return Ok(None);
        };
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => return Ok(None),
            Err(_) => return Err(UNAVAILABLE),
        };
        let helper = probe::peer_pid(&stream).map_err(|_| UNAVAILABLE)?;
        // A client-provided PID or an unverified helper image is never authority.
        if process::verify_helper(helper, ssh, self.image).is_err() {
            return Ok(None);
        }
        process::verify_ssh(ssh, self.owner)?;
        stream.set_nonblocking(true).map_err(|_| UNAVAILABLE)?;
        Ok(Some(stream))
    }

    pub(super) fn close(&mut self, paths: &PrivatePaths) -> Result<(), ErrorCode> {
        if let Some((listener, stamp)) = self.endpoint.take() {
            drop(listener);
            if self.path != paths.askpass_path()? || observe_endpoint(&self.path)? != stamp {
                return Err(UNAVAILABLE);
            }
            fs::remove_file(&self.path).map_err(|_| UNAVAILABLE)?;
        }
        Ok(())
    }
}

fn observe_endpoint(path: &Path) -> Result<(u64, u64), ErrorCode> {
    let meta = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    if !meta.file_type().is_socket()
        || meta.uid() != paths::uid()
        || meta.mode() & 0o7777 != 0o600
        || meta.nlink() != 1
    {
        return Err(UNAVAILABLE);
    }
    Ok((meta.dev(), meta.ino()))
}

pub(super) fn release(
    stream: UnixStream,
    secret: Secret<'_>,
    deadline: Instant,
) -> Result<(), ErrorCode> {
    let length = u16::try_from(secret.0.len()).map_err(|_| UNAVAILABLE)?;
    probe::write(&mut &stream, &length.to_be_bytes(), deadline)?;
    probe::write(&mut &stream, secret.0, deadline)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(in super::super::super::super) fn maybe_run_password_helper() -> Option<ExitCode> {
    let socket = PathBuf::from(env::var_os(SOCKET)?);
    Some(match run(&socket) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    })
}

fn allowed_prompt(actual: &OsStr, expected: &OsStr, hint: Option<&OsStr>) -> bool {
    hint.is_none() && actual == expected
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run(socket: &Path) -> Result<(), ErrorCode> {
    let deadline = Instant::now() + super::super::CHECK_LIMIT;
    let mut args = env::args_os().skip(1);
    let prompt = args.next().ok_or(UNAVAILABLE)?;
    let expected = env::var_os(PROMPT).ok_or(UNAVAILABLE)?;
    let hint = env::var_os("SSH_ASKPASS_PROMPT");
    if args.next().is_some()
        || !allowed_prompt(&prompt, &expected, hint.as_deref())
        || env::var_os("SSH_ASKPASS_REQUIRE").as_deref() != Some(OsStr::new("force"))
    {
        return Err(ErrorCode::OperationDenied);
    }
    let owner = env::var(EXPECTED_OWNER)
        .ok()
        .and_then(|pid| pid.parse::<u32>().ok())
        .ok_or(UNAVAILABLE)?;
    // SAFETY: getppid takes no arguments and observes the current process.
    let ssh = u32::try_from(unsafe { libc::getppid() }).map_err(|_| UNAVAILABLE)?;
    process::verify_ssh(ssh, owner)?;
    let (_, image) = process::helper_image()?;
    if process::Image::running(owner)? != image {
        return Err(UNAVAILABLE);
    }
    prepare_output_pipe()?;
    // Check the kernel's owner PID on this exact descriptor before accepting
    // credentials. Both ends bind the expected SSH/owner/helper image chain.
    let stream = probe::connect_owned(socket, owner, deadline)?;
    let mut length = [0; 2];
    probe::read(&mut &stream, &mut length, deadline)?;
    let length = usize::from(u16::from_be_bytes(length));
    if !(1..=PASSWORD_CAP).contains(&length) {
        return Err(UNAVAILABLE);
    }
    let mut buffer = [0u8; PASSWORD_CAP + 1];
    let output = Secret(buffer.get_mut(..=length).ok_or(UNAVAILABLE)?);
    let (newline, password) = output.0.split_last_mut().ok_or(UNAVAILABLE)?;
    probe::read(&mut &stream, password, deadline)?;
    if !valid_password(password) || Instant::now() >= deadline {
        return Err(UNAVAILABLE);
    }
    *newline = b'\n';
    // SAFETY: stdout is the verified SSH helper's nonblocking pipe. The
    // output points to initialized bytes and stays valid for the syscall.
    let count = unsafe {
        libc::write(
            libc::STDOUT_FILENO,
            output.0.as_ptr().cast(),
            output.0.len(),
        )
    };
    // POSIX guarantees <= PIPE_BUF (at least 512) is written atomically or
    // rejected. Do not buffer the password or retry ambiguous output.
    if usize::try_from(count) != Ok(output.0.len()) {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn prepare_output_pipe() -> Result<(), ErrorCode> {
    let fd = libc::STDOUT_FILENO;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fstat accepts any fd and stat is writable storage.
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return Err(UNAVAILABLE);
    }
    // SAFETY: successful fstat initialized the record.
    if unsafe { stat.assume_init() }.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return Err(UNAVAILABLE);
    }
    // SAFETY: fd is the private stdout pipe and fcntl uses the specified flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    // SAFETY: F_SETFL takes the flags as an integer for the verified open fd.
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0 {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

#[cfg(test)]
#[test]
fn only_the_exact_password_prompt_without_a_hint_is_allowed() {
    let expected = OsStr::new("fixture@127.0.0.1's password: ");
    assert!(allowed_prompt(expected, expected, None));
    for prompt in ["Password: ", "OTP: ", "Passcode: ", "New password: "] {
        assert!(!allowed_prompt(OsStr::new(prompt), expected, None));
    }
    assert!(!allowed_prompt(
        expected,
        expected,
        Some(OsStr::new("none"))
    ));
}
