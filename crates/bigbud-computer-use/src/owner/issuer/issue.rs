use super::{ApprovedGeneration, LaunchGuard};
use crate::{
    Role,
    guard::RetainedRecovery,
    owner::{
        image_preflight::ImagePreflight,
        private_bootstrap::{BootstrapPermit, IssuerBinding},
    },
};
use std::{io, path::Path};

#[derive(Debug)]
pub enum IssueError {
    RoleMismatch,
    Storage,
    SessionInvalidated,
    IdentityUnbound,
    Image(io::Error),
    DigestMismatch,
    Descriptors(io::Error),
}

impl RetainedRecovery<'_> {
    /// Dormant: never invoked by roles. `candidate` is untrusted input; only
    /// a digest equal to the approved generation can make it first-party.
    pub fn issue_bootstrap(
        &mut self,
        guard: &LaunchGuard,
        approved: &ApprovedGeneration,
        role: Role,
        candidate: &Path,
    ) -> Result<BootstrapPermit, IssueError> {
        self.check_issuer_state(approved, role)?;
        // Fresh sample at issuance (no stale earlier binding is reused).
        self.sample_interactive_identity()
            .map_err(|_| IssueError::IdentityUnbound)?;
        let image = ImagePreflight::inspect_candidate(candidate).map_err(IssueError::Image)?;
        self.finish_issue(guard, approved, image)
    }

    fn check_issuer_state(
        &mut self,
        approved: &ApprovedGeneration,
        role: Role,
    ) -> Result<(), IssueError> {
        if approved.role != role {
            return Err(IssueError::RoleMismatch);
        }
        if self.verify_storage().is_err() {
            return Err(IssueError::Storage);
        }
        self.check_session()
    }

    fn check_session(&self) -> Result<(), IssueError> {
        if self.session_invalidation().is_some() {
            return Err(IssueError::SessionInvalidated);
        }
        if !self.interactive_identity_bound() {
            return Err(IssueError::IdentityUnbound);
        }
        Ok(())
    }

    pub(super) fn finish_issue(
        &mut self,
        guard: &LaunchGuard,
        approved: &ApprovedGeneration,
        image: ImagePreflight,
    ) -> Result<BootstrapPermit, IssueError> {
        let digest = image.sha256().map_err(IssueError::Image)?;
        if digest != approved.digest {
            return Err(IssueError::DigestMismatch);
        }
        guard
            .audit_descriptors(&[])
            .map_err(IssueError::Descriptors)?;
        // Invalidation may have arrived during hashing/audit: recheck last.
        self.check_session()?;
        let bound = IssuerBinding {
            session: self.session_invalidator(),
            fence: self.launch_fence().clone(),
            fence_epoch: self
                .launch_fence()
                .load(std::sync::atomic::Ordering::SeqCst),
        };
        Ok(BootstrapPermit::issued(
            image.path().to_path_buf(),
            image,
            digest,
            (approved.role, approved.generation.clone()),
            bound,
        ))
    }

    #[cfg(test)]
    pub(super) fn issue_fixture(
        &mut self,
        guard: &LaunchGuard,
        approved: &ApprovedGeneration,
        role: Role,
        image: ImagePreflight,
    ) -> Result<BootstrapPermit, IssueError> {
        self.check_issuer_state(approved, role)?;
        self.finish_issue(guard, approved, image)
    }
}
