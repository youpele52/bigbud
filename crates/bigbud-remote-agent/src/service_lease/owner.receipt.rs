//! Durable readiness receipt hooks for the single original entry. The receipt is
//! recovery evidence only; consent and validity stay with the canonical journal guard.
use super::*;
use crate::service_lease::receipt::{self, Receipt, Store};
use crate::service_lease::recovery;

impl LeaseOwner {
    /// Trusted embedding: durable receipts live in this private account-state directory.
    pub fn with_receipts(mut self, root: PathBuf) -> Result<Self> {
        self.receipts = Some(Store::new(root)?);
        Ok(self)
    }

    /// Before any spawn: validate the upstream argument and bound retained receipts.
    /// Returns the upstream path to record when this launch will produce a receipt.
    pub(super) fn prepare_receipt(&self, launch: &Launch) -> Result<Option<Option<PathBuf>>> {
        let upstream = receipt::upstream_argument(&launch.args)?;
        let Some(store) = &self.receipts else {
            return Ok(None);
        };
        if launch.validate_gateway_readiness().is_err() {
            return Ok(None);
        }
        // No entry exists here, so every retained receipt is orphaned evidence.
        store.prepare(|old| old.child.dead())?;
        Ok(Some(upstream))
    }

    pub(super) fn record_receipt(&mut self, upstream: Option<Option<PathBuf>>) -> Result<()> {
        let Some(upstream) = upstream else {
            return Ok(());
        };
        let store = self.receipts.as_ref().ok_or(Error::Uncertain)?;
        let entry = self.entry.as_mut().ok_or(Error::Uncertain)?;
        let original = entry.monitor.original.ok_or(Error::Uncertain)?;
        entry.receipt = Some(recovery::record(
            store,
            &entry.binding,
            &entry.controller,
            entry.monitor.child_pid,
            original,
            upstream,
        )?);
        Ok(())
    }

    /// Called only after the current controller was proven dead. Never mutates the entry.
    pub(super) fn recover_receipt(&self, successor: &Controller) -> Result<Option<Receipt>> {
        let Some(entry) = self.entry.as_ref() else {
            return Err(Error::Refused);
        };
        let Some(current) = entry.receipt.as_ref() else {
            return Ok(None);
        };
        let store = self.receipts.as_ref().ok_or(Error::Uncertain)?;
        if current.controller != entry.controller || current.binding != entry.binding {
            return Err(Error::Uncertain);
        }
        recovery::recover(store, current, successor).map(Some)
    }

    /// Same-controller Resume: attach a successor's sealed upstream, or stay Attaching.
    pub(super) fn attach_receipt(&mut self) -> Result<()> {
        let (Some(store), Some(entry)) = (self.receipts.as_ref(), self.entry.as_mut()) else {
            return Ok(());
        };
        let Some(current) = entry.receipt.as_ref().filter(|r| r.attaching()) else {
            return Ok(());
        };
        if let Some(next) = recovery::attach(store, current, &entry.controller)? {
            entry.receipt = Some(next);
        }
        Ok(())
    }

    /// After a confirmed original-child exit, before the entry is retired.
    pub(super) fn release_receipt(&mut self, successor: bool) {
        let (Some(store), Some(entry)) = (self.receipts.as_ref(), self.entry.as_mut()) else {
            return;
        };
        let Some(current) = entry.receipt.take() else {
            return;
        };
        // The confirmed exit stands either way. A preserved stale socket keeps fresh TypeScript
        // activation fenced (it refuses an existing socket), and leftover receipt evidence is
        // pruned before the next Start once its original child is proven dead.
        let _evidence: Result<()> = recovery::release(store, &current, successor);
    }
}
