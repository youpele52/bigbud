use super::{
    bundle_macos::bundle_identifier,
    verified::{BundleIdentity, IdentitySource, VerifiedApp, enclosing_bundle, file_identity},
};
use crate::worker::unix::inspect;
use std::{ffi::OsStr, io, num::NonZeroU32, os::unix::ffi::OsStrExt, path::PathBuf};

/// Verified identity from the OS: creation identity, `proc_pidpath`, creation
/// identity again, then `proc_pidpath` again. A pid reused while the path was
/// read fails (creation differs), and so does an `exec` in between (creation
/// is the start time, which `exec` keeps, but the image path changes).
///
/// Limit: an `exec` after the final read, or an `exec` of the same image
/// path, is not observable here. The result describes the process image at
/// observation time; egress re-verifies on every observation instead of
/// caching a verdict per pid.
#[derive(Debug, Default, Clone, Copy)]
pub struct MacIdentitySource;

fn executable_path(pid: NonZeroU32) -> io::Result<PathBuf> {
    let mut buffer = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: writable buffer of exactly the stated size; pid range was checked
    // by `inspect` before this call.
    let length = unsafe {
        libc::proc_pidpath(
            pid.get() as i32,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        return Err(io::Error::last_os_error());
    }
    let path = PathBuf::from(OsStr::from_bytes(
        buffer
            .get(..length as usize)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?,
    ));
    if !path.is_absolute() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(path)
}

impl IdentitySource for MacIdentitySource {
    fn resolve(&self, pid: NonZeroU32) -> io::Result<VerifiedApp> {
        let before = inspect(pid)?;
        let executable = executable_path(pid)?;
        let after = inspect(pid)?;
        if before.creation != after.creation {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "pid reused during inspection",
            ));
        }
        if executable_path(pid)? != executable {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "process image changed during inspection",
            ));
        }
        let bundle = enclosing_bundle(&executable).map(|path| BundleIdentity {
            identifier: bundle_identifier(&path),
            file: file_identity(&path),
            path,
        });
        Ok(VerifiedApp {
            pid,
            creation: after.creation,
            executable_file: file_identity(&executable),
            executable,
            bundle,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command};

    #[test]
    fn resolves_an_owned_dummy_child_without_a_bundle() {
        let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let pid = NonZeroU32::new(child.id()).unwrap();
        let app = MacIdentitySource.resolve(pid);
        child.kill().unwrap();
        child.wait().unwrap();
        let app = app.unwrap();
        assert_eq!(app.pid, pid);
        assert_eq!(app.executable, Path::new("/bin/sleep"));
        assert!(app.bundle.is_none());
        assert!(app.executable_file.is_some());
        assert!(!app.creation.is_empty());
        // Once reaped, the pid no longer verifies.
        assert!(
            MacIdentitySource
                .resolve(pid)
                .map(|a| a.creation != app.creation)
                .unwrap_or(true)
        );
    }

    #[test]
    fn reads_a_system_bundle_identifier_from_metadata_only() {
        let calculator = Path::new("/System/Applications/Calculator.app");
        if !calculator.exists() {
            return;
        }
        assert_eq!(
            bundle_identifier(calculator).as_deref(),
            Some("com.apple.calculator")
        );
        assert_eq!(bundle_identifier(Path::new("/nonexistent/Nope.app")), None);
    }
}
