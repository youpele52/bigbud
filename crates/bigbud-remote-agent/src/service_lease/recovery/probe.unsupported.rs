//! Non-Linux builds never construct a lease owner; every observation stays unknown.
use super::decide::{Child, Connect, FreshPath, GatewayObservation, StalePath};
use crate::service_lease::receipt::{Receipt, SocketIdentity};
use crate::service_lease::{Controller, Error, Result};
use std::path::Path;

pub(in crate::service_lease) fn gateway(_receipt: &Receipt) -> GatewayObservation {
    GatewayObservation {
        child: Child::Unknown,
        holds: None,
        connect: Connect::Unknown,
    }
}
pub(in crate::service_lease) fn published(_path: &Path) -> Result<SocketIdentity> {
    Err(Error::Unsupported)
}
pub(in crate::service_lease) fn stale(
    _path: &Path,
    _recorded: Option<SocketIdentity>,
) -> StalePath {
    StalePath::Unknown
}
pub(in crate::service_lease) fn unlink_recorded(
    _path: &Path,
    _recorded: SocketIdentity,
) -> Result<bool> {
    Err(Error::Unsupported)
}
pub(in crate::service_lease) fn fresh(
    _path: &Path,
    _controller: &Controller,
) -> (FreshPath, Option<SocketIdentity>) {
    (FreshPath::Unknown, None)
}
