//! A T-backend lease: its caller-chosen token, the owner-made socket path (when
//! bytes are streamed) and the shared lease worker that owns the thread.

use super::ErrorCode;
use crate::{
    Token,
    owner::lease_worker::{self, Signals},
};

pub(super) struct Worker<T: Clone + Send + 'static> {
    pub(super) token: Token,
    pub(super) socket_path: Option<String>,
    inner: lease_worker::Worker<T>,
}

impl<T: Clone + Send + 'static> Worker<T> {
    pub(super) fn spawn(
        token: Token,
        socket_path: Option<String>,
        lost: T,
        name: &str,
        body: impl FnOnce(Signals) -> T + Send + 'static,
    ) -> Result<Self, ErrorCode> {
        let inner = lease_worker::Worker::spawn(name, lost, body)
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        Ok(Self {
            token,
            socket_path,
            inner,
        })
    }

    pub(super) fn observe(&mut self) -> Option<T> {
        self.inner.settled()
    }

    /// Request cancellation and wait, bounded, for the worker to settle.
    pub(super) fn retire(&mut self) -> Option<T> {
        self.inner.retire()
    }

    pub(super) fn started(&self) -> bool {
        self.inner.is_streaming()
    }
}
