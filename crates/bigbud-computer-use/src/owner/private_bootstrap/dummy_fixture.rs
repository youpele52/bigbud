//! cfg(test)-only first-party dummy plumbing. No production permit is minted.
use super::{endpoint::Endpoint, exchange::ParentExchange, route::Route};
use crate::{Role, owner::AuthenticatedPeer, worker::ExecutionRoot};
use std::{
    io,
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::Stdio,
    time::Instant,
};

pub(crate) struct DummyExchange {
    endpoint: Endpoint,
    route: Route,
    exchange: ParentExchange,
    deadline: Instant,
}
impl DummyExchange {
    pub(crate) fn prepare(deadline: Instant) -> io::Result<(Self, Stdio)> {
        let endpoint = Endpoint::create(deadline)?;
        let route = Route::current(endpoint.directory.nonce)?;
        let (exchange, courier) = ParentExchange::pair(deadline)?;
        Ok((
            Self {
                endpoint,
                route,
                exchange,
                deadline,
            },
            Stdio::from(OwnedFd::from(courier)),
        ))
    }
    pub(crate) fn authenticate(self, root: ExecutionRoot) -> io::Result<AuthenticatedPeer> {
        let mut capability = self
            .exchange
            .deliver_routed(root, Role::Worker, &self.route)?;
        let stream = self.endpoint.accept(self.deadline)?;
        capability.authenticate_stream(stream)
    }
}
pub(crate) fn child_connect(deadline: Instant) -> io::Result<UnixStream> {
    // This entry exists only in the first-party dummy's dedicated stdin phase.
    // It reuses production startup fd0 ownership/CLOEXEC/consumption, not a fake
    // permit or public caller-supplied process adoption API.
    let bootstrap = super::launch::read_dummy_startup_stdin(deadline)?;
    // SAFETY: read-only query of the now-consumed dedicated stdin slot. No other
    // file is opened between courier closure and this check, so EBADF proves it
    // closed before the separate post-exec connection can reuse that number.
    let flags = unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_GETFD) };
    if flags != -1 || io::Error::last_os_error().raw_os_error() != Some(libc::EBADF) {
        return Err(io::Error::other("dummy courier not consumed"));
    }
    bootstrap.connect()
}
