//! Receipt-bound successor recovery. Each step either proves its condition or stays
//! uncertain; nothing here grants consent, which remains in the canonical journal guard.
use super::decide::{self, Attach, Gateway, Stale};
use super::probe;
use crate::service_lease::process::readiness::Proof;
use crate::service_lease::receipt::{Listener, Receipt, Store, Upstream};
use crate::service_lease::{Binding, Controller, Error, Result};
use std::path::PathBuf;

/// Revision 1, written only after original-child readiness was proven.
pub(in crate::service_lease) fn record(
    store: &Store,
    binding: &Binding,
    controller: &Controller,
    child_pid: u32,
    original: (Proof, u64),
    upstream: Option<PathBuf>,
) -> Result<Receipt> {
    let (proof, started) = original;
    let upstream = upstream
        .map(|path| {
            Ok::<_, Error>(Upstream {
                socket: Some(probe::published(&path)?),
                path,
            })
        })
        .transpose()?;
    let receipt = Receipt {
        revision: 1,
        binding: binding.clone(),
        original_controller: controller.clone(),
        controller: controller.clone(),
        child: Controller {
            pid: child_pid,
            boot: controller.boot.clone(),
            started: started.to_string(),
        },
        listener: Listener {
            address: proof.address,
            inode: proof.inode,
        },
        upstream,
    };
    store.write(&receipt)?;
    Ok(receipt)
}

/// The durable copy must still be exactly the owner's in-memory receipt.
fn durable(store: &Store, current: &Receipt) -> Result<()> {
    if store.read(&current.binding.nonce)?.as_ref() != Some(current) {
        return Err(Error::Uncertain);
    }
    Ok(())
}
fn live_gateway(current: &Receipt) -> Result<()> {
    match decide::gateway(probe::gateway(current)) {
        Gateway::Live => Ok(()),
        // The monitor settles the exited child; terminal status then permits a fresh Start.
        Gateway::Gone => Err(Error::Refused),
        Gateway::Uncertain => Err(Error::Uncertain),
    }
}

/// Clear the dead controller's upstream path: absent, or exactly the recorded inode
/// after an explicit `ECONNREFUSED`. Returns the cleared upstream awaiting attach.
pub(in crate::service_lease) fn resolve_stale(current: &Receipt) -> Result<Option<Upstream>> {
    let Some(upstream) = &current.upstream else {
        return Ok(None);
    };
    let cleared = Upstream {
        path: upstream.path.clone(),
        socket: None,
    };
    match decide::stale(probe::stale(&upstream.path, upstream.socket)) {
        Stale::Clear => Ok(Some(cleared)),
        Stale::Unlink => {
            let recorded = upstream.socket.ok_or(Error::Uncertain)?;
            if probe::unlink_recorded(&upstream.path, recorded)? {
                Ok(Some(cleared))
            } else {
                Err(Error::Uncertain)
            }
        }
        Stale::Preserve => Err(Error::Uncertain),
    }
}

/// Successor takeover after the caller proved `current.controller` dead. The original
/// child must still serve its recorded listener; the stale upstream is cleared first.
pub(in crate::service_lease) fn recover(
    store: &Store,
    current: &Receipt,
    successor: &Controller,
) -> Result<Receipt> {
    durable(store, current)?;
    live_gateway(current)?;
    let upstream = resolve_stale(current)?;
    let next = Receipt {
        revision: current.revision.checked_add(1).ok_or(Error::Uncertain)?,
        controller: successor.clone(),
        upstream,
        ..current.clone()
    };
    store.write(&next).map_err(|_| Error::Uncertain)?;
    Ok(next)
}

/// Attach the current controller's newly sealed upstream. `Ok(None)` stays unready.
pub(in crate::service_lease) fn attach(
    store: &Store,
    current: &Receipt,
    controller: &Controller,
) -> Result<Option<Receipt>> {
    let upstream = current.upstream.as_ref().ok_or(Error::Invalid)?;
    if current.controller != *controller || upstream.socket.is_some() {
        return Err(Error::Invalid);
    }
    durable(store, current)?;
    let (observed, identity) = probe::fresh(&upstream.path, controller);
    match decide::attach(observed) {
        Attach::Pending => Ok(None),
        Attach::Uncertain => Err(Error::Uncertain),
        Attach::Attached => {
            // The original child is re-verified last, immediately before readiness.
            live_gateway(current)?;
            let next = Receipt {
                revision: current.revision.checked_add(1).ok_or(Error::Uncertain)?,
                upstream: Some(Upstream {
                    path: upstream.path.clone(),
                    socket: Some(identity.ok_or(Error::Uncertain)?),
                }),
                ..current.clone()
            };
            store.write(&next).map_err(|_| Error::Uncertain)?;
            Ok(Some(next))
        }
    }
}

/// After a confirmed child exit. A successor also clears the dead controller's exact stale
/// socket so a fresh Start can publish; a live controller's own socket is never touched.
pub(in crate::service_lease) fn release(
    store: &Store,
    current: &Receipt,
    successor: bool,
) -> Result<()> {
    let stale = if successor {
        resolve_stale(current).map(|_| ())
    } else {
        Ok(())
    };
    store.remove(current)?;
    stale
}
