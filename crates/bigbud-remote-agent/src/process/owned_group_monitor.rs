//! Shared exact group cleanup; call only from an isolated monitor process.
// ServiceError is retained by the finite-monitor adapter during extraction.
use crate::backend_service::{Result, ServiceError};
use std::process::Child;
use std::time::{Duration, Instant};
#[path = "../backend_service/command.monitor.group.rs"]
mod group;
pub(crate) fn prepare() -> Result<()> {
    group::prepare()
}
pub(crate) fn exited(pid: i32) -> Result<bool> {
    group::exited(pid)
}
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn descendants_remain(pid: i32) -> Result<bool> {
    group::descendants_remain(pid)
}

pub(crate) fn cleanup(child: &mut Child) -> Result<()> {
    cleanup_observing(child, |pid| {
        Ok((group::exited(pid)?, group::descendants_remain(pid)?))
    })
}

pub(crate) fn cleanup_observing(
    child: &mut Child,
    mut observe: impl FnMut(i32) -> Result<(bool, bool)>,
) -> Result<()> {
    let pid = i32::try_from(child.id()).map_err(|_| ServiceError::Manager)?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut failure = None;
    // Hold the direct leader unreaped through EVERY signal, including observer failures.
    // A failed kernel observation is never evidence that the group has stopped.
    loop {
        match observe(pid) {
            Ok((true, false)) => {
                child.wait()?;
                return match failure {
                    Some(error) => Err(error),
                    None => Ok(()),
                };
            }
            Ok(_) => (),
            Err(error) => {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        // Darwin zombie-only EPERM is avoided only after positive observation above.
        // On observation failure still attempt exact owned-group cleanup repeatedly.
        if let Err(error) = group::signal(pid) {
            // The leader can exit after the observation above. EPERM is qualified ONLY
            // by a new stopped proof while we still own its unreaped kernel identity.
            if matches!(&error, ServiceError::Io(io) if io.raw_os_error() == Some(libc::EPERM)) {
                match observe(pid) {
                    Ok((true, false)) => {
                        child.wait()?;
                        return match failure {
                            Some(error) => Err(error),
                            None => Ok(()),
                        };
                    }
                    Err(observation_error) if failure.is_none() => {
                        failure = Some(observation_error)
                    }
                    _ => (),
                }
            }
            if failure.is_none() {
                failure = Some(error);
            }
        }
        if Instant::now() >= deadline {
            // No more signals may follow this final reap attempt. A still-live child is
            // reported as uncertain failure after bounded repeated SIGKILL, never success.
            let _settled_direct_child = child.try_wait()?;
            return Err(match failure {
                Some(error) => error,
                None => ServiceError::Manager,
            });
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
