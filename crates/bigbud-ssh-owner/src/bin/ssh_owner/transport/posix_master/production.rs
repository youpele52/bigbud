//! Production master lane: a real verified master for one resolved target.
//!
//! The control path is allocated under the owner's 0700 state root, the
//! target's own identity/trust policy supplies the pin, and only the bound
//! system image is admitted. The caller's request deadline stays the upper
//! bound; a failed policy never reaches a spawn.

use super::{
    ErrorCode, Folders, Instant, PosixMasterSlot, PrivatePaths, READY_LIMIT, Transport,
    UNAVAILABLE, classify_list_io, launch, session,
};
use crate::Token;
use std::path::Path;

impl PosixMasterSlot {
    pub(in super::super::super) fn open_and_list_production_folders(
        &mut self,
        transport: &Transport,
        generation: Token,
        path: Option<&str>,
        deadline: Instant,
        root: &Path,
    ) -> Result<Folders, ErrorCode> {
        let picker = session::Picker::new(path)?;
        if Instant::now() >= deadline {
            return Err(ErrorCode::ListTimedOut);
        }
        if self.master.is_none() {
            self.open_production_before(transport, generation, deadline, || {
                PrivatePaths::new_owner_private(root)
            })
            .map_err(|error| classify_list_io(error, deadline))?;
        }
        self.list(transport, generation, picker, deadline, false)
    }

    fn open_production_before(
        &mut self,
        transport: &Transport,
        generation: Token,
        deadline: Instant,
        allocate: impl FnOnce() -> Result<PrivatePaths, ErrorCode>,
    ) -> Result<(), ErrorCode> {
        let ready_by = deadline.min(Instant::now() + READY_LIMIT);
        let mut command = self.prepare_with(
            transport,
            generation,
            allocate,
            &[],
            super::TrustRead::Default,
            true,
        )?;
        let master = self.master.as_mut().ok_or(UNAVAILABLE)?;
        let result = (|| {
            master.spawn(&mut command, ready_by)?;
            master.await_ready(ready_by)?;
            master.binding.revalidate(transport)
        })();
        self.finish_check(generation, result)
    }
}

/// Production PTY admission: only the bound system image, credentials and
/// policy, revalidated without the disposable loopback fixture requirement.
pub(in super::super::super) fn validate_production_image(
    transport: &Transport,
) -> Result<(), ErrorCode> {
    launch::validate_production(transport).map(drop)
}
