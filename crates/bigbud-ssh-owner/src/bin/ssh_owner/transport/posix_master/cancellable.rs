//! Exact-request local cancellation for the disposable macOS and Linux pickers only.

use super::{
    CANCELLED, CHECK_LIMIT, Cancel, ErrorCode, Folders, Instant, PosixMasterSlot, PrivatePaths,
    READY_LIMIT, Token, Transport, TrustRead, UNAVAILABLE, checkpoint, classify_list_io, session,
};
use crate::transport::{HostVerification, ListFailure};

impl PosixMasterSlot {
    /// The owner's request inbox supplies the exact request's cancellation bit.
    /// A cancellation receipt proves only local cleanup, not remote termination.
    pub(in super::super::super) fn open_and_list_folders_cancellable(
        &mut self,
        transport: &Transport,
        generation: Token,
        path: Option<&str>,
        deadline: Instant,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<Folders, ListFailure> {
        if self.master.is_some() && self.admit(transport, generation)?.binding.password {
            return Err(ErrorCode::OperationDenied.into());
        }
        if is_cancelled() {
            // No session was admitted by this request. Leave an idle lease alone.
            return Err(ListFailure::Cancelled);
        }
        if transport.policy.is_some()
            || transport.host_verification() != HostVerification::Ed25519Key
        {
            return Err(ErrorCode::ConfigUnsupported.into());
        }
        let picker = session::Picker::new(path)?;
        if Instant::now() >= deadline {
            return Err(ErrorCode::ListTimedOut.into());
        }
        let cancel: Cancel<'_> = Some(&is_cancelled);
        #[cfg(target_os = "macos")]
        let trust = TrustRead::PlainFixture;
        // The Linux fixture pin uses the default store reader and its checks.
        #[cfg(target_os = "linux")]
        let trust = TrustRead::Default;
        let result = (|| {
            if self.master.is_none() {
                let root = transport.config.identity.parent().ok_or(UNAVAILABLE)?;
                let ready_by = deadline.min(Instant::now() + READY_LIMIT);
                let mut command = self.prepare_with(
                    transport,
                    generation,
                    || PrivatePaths::new_in(root),
                    &[],
                    trust,
                )?;
                let master = self.admit(transport, generation)?;
                checkpoint(cancel)?;
                master.spawn(&mut command, ready_by)?;
                master.await_ready_with(ready_by, cancel)?;
            }
            let master = self.admit(transport, generation)?;
            let stream = master.connect_with(transport, deadline, trust, cancel)?;
            let output = picker.run_with(&stream, deadline, cancel)?;
            master.binding.revalidate_with(transport, trust)?;
            checkpoint(cancel)?;
            Ok(output)
        })();
        // The exact session control socket and owned stdio were dropped above
        // before potentially killing and reaping the retained master child.
        let result = match result {
            Ok(output) => {
                let folders = output.folders();
                if !is_cancelled() {
                    return Ok(folders?);
                }
                CANCELLED
            }
            Err(_) if is_cancelled() => CANCELLED,
            Err(error) => error,
        };
        self.finish_cancellable_failure(generation, result, deadline)
    }

    fn finish_cancellable_failure(
        &mut self,
        generation: Token,
        error: ErrorCode,
        deadline: Instant,
    ) -> Result<Folders, ListFailure> {
        if error == CANCELLED
            && let Some(master) = &mut self.master
            && master.socket.is_none()
        {
            // Cancellation can arrive during publication. Try one nonblocking
            // peer/inode check before reap. If it cannot prove ownership, checked
            // invalidation below cannot remove any residual unknown socket.
            let _attempt = master.remember_socket(Instant::now() + CHECK_LIMIT);
        }
        self.invalidate(generation)
            .map_err(|_| ListFailure::CleanupUnconfirmed)?;
        if error == CANCELLED {
            Err(ListFailure::Cancelled)
        } else {
            Err(classify_list_io(error, deadline).into())
        }
    }
}
