//! Kernel-derived transport peer; no PID supplied by a wire request.
use super::{Controller, Error, Result};
#[derive(Clone)]
pub struct Peer {
    identity: Controller,
    parent: u32,
}
impl Peer {
    #[cfg(target_os = "linux")]
    pub(crate) fn current_process() -> Result<Self> {
        Ok(Self {
            identity: Controller::current()?,
            parent: parent(std::process::id())?,
        })
    }
    pub(crate) fn pid(&self) -> u32 {
        self.identity.pid
    }
    pub(crate) fn current(&self) -> Result<bool> {
        Ok(Controller::read(self.identity.pid)? == self.identity
            && parent(self.identity.pid)? == self.parent)
    }
    /// Kernel identity of the peer that created the connected or listening socket.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn identity(&self) -> &Controller {
        &self.identity
    }
    pub(crate) fn parent_pid(&self) -> u32 {
        self.parent
    }
    #[cfg(target_os = "linux")]
    pub(crate) fn read(stream: &std::os::unix::net::UnixStream) -> Result<Self> {
        use std::os::fd::AsRawFd;
        let mut credentials = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: initialized writable ucred and correct length for this owned socket.
        if unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: geteuid only reads the actual account identity.
        if length as usize != std::mem::size_of::<libc::ucred>()
            || credentials.pid <= 1
            || credentials.uid != unsafe { libc::geteuid() }
        {
            return Err(Error::Refused);
        }
        Ok(Self {
            identity: Controller::read(credentials.pid as u32)?,
            parent: parent(credentials.pid as u32)?,
        })
    }
    #[cfg(not(target_os = "linux"))]
    pub(crate) fn read(_stream: &std::os::unix::net::UnixStream) -> Result<Self> {
        Err(Error::Unsupported)
    }
}
#[cfg(target_os = "linux")]
fn parent(pid: u32) -> Result<u32> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(format!("/proc/{pid}/stat"))?
        .take(8193)
        .read_to_string(&mut text)?;
    if text.len() > 8192 {
        return Err(Error::Invalid);
    }
    let fields = text.rsplit_once(") ").ok_or(Error::Invalid)?.1;
    fields
        .split_whitespace()
        .nth(1)
        .and_then(|p| p.parse::<u32>().ok())
        .filter(|p| *p > 0)
        .ok_or(Error::Invalid)
}
#[cfg(not(target_os = "linux"))]
fn parent(_pid: u32) -> Result<u32> {
    Err(Error::Unsupported)
}
