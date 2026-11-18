//! Linux kernel observations for successor recovery. Observation never mutates;
//! `unlink_recorded` is the only removal and re-checks the exact inode first.
use super::decide::{Child, Connect, FreshPath, GatewayObservation, StalePath};
use crate::backend_service::{ServiceError, bounded_connect};
use crate::service_lease::process::readiness::{holds_socket, listener_inode};
use crate::service_lease::receipt::{Receipt, SocketIdentity};
use crate::service_lease::{Controller, Error, Peer, Result};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

fn child(recorded: &Controller) -> Child {
    match recorded.dead() {
        Ok(true) => Child::Gone,
        Ok(false) => Child::Original,
        Err(_) => Child::Unknown,
    }
}
fn classify(error: &std::io::Error) -> Connect {
    if error.kind() == std::io::ErrorKind::ConnectionRefused {
        Connect::Refused
    } else {
        Connect::Unknown
    }
}

/// Connect first, then require the recorded inode in the unchanged original child.
pub(in crate::service_lease) fn gateway(receipt: &Receipt) -> GatewayObservation {
    let before = child(&receipt.child);
    let connect =
        match std::net::TcpStream::connect_timeout(&receipt.listener.address, CONNECT_TIMEOUT) {
            Ok(_stream) => Connect::Accepted,
            Err(error) => classify(&error),
        };
    let holds = (before == Child::Original)
        .then(|| {
            let listening = listener_inode(receipt.listener.address).ok()?;
            let held = holds_socket(receipt.child.pid, receipt.listener.inode).ok()?;
            Some(listening == Some(receipt.listener.inode) && held)
        })
        .flatten();
    let after = child(&receipt.child);
    GatewayObservation {
        // A child that changed during observation is never Live.
        child: if before == after {
            before
        } else {
            Child::Unknown
        },
        holds,
        connect,
    }
}

enum Sealed {
    Absent,
    Socket(SocketIdentity),
    Other,
}
/// A private sealed socket: not a symlink, owned by this account, 0600 and single-linked.
fn sealed(path: &Path) -> Result<Sealed> {
    let info = match std::fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Sealed::Absent),
        Err(error) => return Err(error.into()),
    };
    // SAFETY: geteuid only reads the executing account identity.
    if !info.file_type().is_socket()
        || info.uid() != unsafe { libc::geteuid() }
        || info.mode() & 0o7777 != 0o600
        || info.nlink() != 1
    {
        return Ok(Sealed::Other);
    }
    Ok(Sealed::Socket(SocketIdentity {
        dev: info.dev(),
        ino: info.ino(),
    }))
}
/// Readiness-time identity of the controller's published upstream socket.
pub(in crate::service_lease) fn published(path: &Path) -> Result<SocketIdentity> {
    match sealed(path)? {
        Sealed::Socket(identity) => Ok(identity),
        Sealed::Absent | Sealed::Other => Err(Error::Uncertain),
    }
}
fn unix_connect(path: &Path) -> (Connect, Option<std::os::unix::net::UnixStream>) {
    match bounded_connect(path) {
        Ok(stream) => (Connect::Accepted, Some(stream)),
        Err(ServiceError::Io(error)) => (classify(&error), None),
        Err(_) => (Connect::Unknown, None),
    }
}

/// `recorded: None` means the stale inode was already cleared; anything now present is unrecorded.
pub(in crate::service_lease) fn stale(path: &Path, recorded: Option<SocketIdentity>) -> StalePath {
    match sealed(path) {
        Ok(Sealed::Absent) => StalePath::Absent,
        Ok(Sealed::Socket(identity)) if Some(identity) == recorded => {
            StalePath::Recorded(unix_connect(path).0)
        }
        Ok(Sealed::Socket(_) | Sealed::Other) => StalePath::Unrecorded,
        Err(_) => StalePath::Unknown,
    }
}

/// Re-check the exact recorded inode immediately before unlinking. Returns false,
/// preserving the path, when anything else now occupies it.
pub(in crate::service_lease) fn unlink_recorded(
    path: &Path,
    recorded: SocketIdentity,
) -> Result<bool> {
    match sealed(path)? {
        Sealed::Socket(identity) if identity == recorded => (),
        Sealed::Absent => return Ok(true),
        Sealed::Socket(_) | Sealed::Other => return Ok(false),
    }
    std::fs::remove_file(path)?;
    let parent = path.parent().ok_or(Error::Invalid)?;
    std::fs::File::open(parent)?.sync_all()?;
    Ok(true)
}

/// The successor's sealed socket must accept and be listened on by `controller` itself.
pub(in crate::service_lease) fn fresh(
    path: &Path,
    controller: &Controller,
) -> (FreshPath, Option<SocketIdentity>) {
    let identity = match sealed(path) {
        Ok(Sealed::Absent) => return (FreshPath::Absent, None),
        Ok(Sealed::Other) => return (FreshPath::Unsealed, None),
        Ok(Sealed::Socket(identity)) => identity,
        Err(_) => return (FreshPath::Unknown, None),
    };
    let (connect, stream) = unix_connect(path);
    let held = stream
        .as_ref()
        .and_then(|stream| Peer::read(stream).ok())
        .map(|peer| peer.identity() == controller);
    // The path must still name the inode that accepted, or the proof is not about it.
    let unchanged = matches!(sealed(path), Ok(Sealed::Socket(after)) if after == identity);
    let observed = FreshPath::Sealed {
        connect,
        held: held.filter(|_| unchanged),
    };
    (observed, Some(identity))
}
