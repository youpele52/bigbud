//! Disposable S1 fixture: one local dispatcher session at a time, under the inherited domain lock.

mod auth;
mod deadline;
mod identity;
mod lifetime;
mod socket;

pub(super) use lifetime::LauncherLifetime;

use std::{
    cell::Cell,
    io,
    os::unix::net::{UnixListener, UnixStream},
    path::Path,
    time::{Duration, Instant},
};

use crate::{RunResult, Token, owner::Owner, owner_pipe::Pipe};

use self::{deadline::DeadlineIo, socket::OwnedSocket};

const AUTH_LIMIT: Duration = Duration::from_secs(2);
const HYDRATE_LIMIT: Duration = Duration::from_secs(5);
const SESSION_IO_LIMIT: Duration = Duration::from_secs(30);

pub(super) struct Attachment {
    _path: OwnedSocket,
    listener: UnixListener,
    capability: Token,
    uid: libc::uid_t,
    /// This owner's artifact identity, measured once at bind (startup).
    identity: Token,
}

impl Attachment {
    pub(super) fn bind(path: &Path, capability: Token) -> io::Result<Self> {
        let uid = socket::effective_uid();
        let identity = identity::measure_self()?;
        let (path, listener) = OwnedSocket::bind(path, uid)?;
        Ok(Self {
            _path: path,
            listener,
            capability,
            uid,
            identity,
        })
    }

    pub(super) fn serve(
        self,
        owner: &mut Owner,
        profile: &[u8],
        lifetime: Option<&LauncherLifetime>,
    ) -> RunResult<()> {
        owner.park();
        loop {
            if let Some(lifetime) = lifetime {
                match lifetime.wait(&self.listener, libc::POLLIN, None) {
                    Ok(()) => (),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == io::ErrorKind::ConnectionAborted => {
                        return owner.retire_for_launcher();
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            let stream = match self.listener.accept() {
                Ok((stream, _)) => stream,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::ConnectionAborted
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            if !matches!(socket::peer_uid(&stream), Ok(uid) if uid == self.uid) {
                continue;
            }
            // Neither peer failures nor ambiguous storage replies release the
            // owner fence. A new peer must authenticate and hydrate afresh.
            drop(self.session(&stream, owner, profile, lifetime));
            if owner.shutdown_requested {
                // Dropping `self` removes the attach socket; the caller exits.
                return Ok(());
            }
            owner.park();
        }
    }

    fn session(
        &self,
        stream: &UnixStream,
        owner: &mut Owner,
        profile: &[u8],
        lifetime: Option<&LauncherLifetime>,
    ) -> RunResult<()> {
        let deadline = Cell::new(Instant::now() + AUTH_LIMIT);
        let io = || DeadlineIo {
            stream,
            deadline: &deadline,
            lifetime,
        };
        let mut pipe = Pipe::new(io(), io());
        if auth::authenticate(&mut pipe, &self.capability, profile, &self.identity)? {
            // Another install path or build: refuse typed, then retire so the
            // backend can start a fresh owner from its own artifact.
            return owner.refuse_foreign_artifact(&mut pipe);
        }
        deadline.set(Instant::now() + HYDRATE_LIMIT);
        owner.rebind(&mut pipe)?;
        owner.serve_session(&mut pipe, |waiting_for_request| {
            if let Some(lifetime) = lifetime.filter(|_| waiting_for_request) {
                // No idle disconnect for the supervised backend. Once any bytes are ready,
                // the whole frame still has the usual deadline.
                lifetime.wait(stream, libc::POLLIN, None)?;
            }
            deadline.set(Instant::now() + SESSION_IO_LIMIT);
            Ok(())
        })
    }
}
