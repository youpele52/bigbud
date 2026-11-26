use super::{Binding, PrivatePaths, Stamp, recovery, trust_store};
use std::process::Child;

pub(super) struct Master {
    pub(super) binding: Binding,
    pub(super) paths: PrivatePaths,
    pub(super) child: Option<Child>,
    /// Kills `child` when the owner exits, including SIGKILL.
    pub(super) death_watch: Option<super::owner_death::Watch>,
    /// The owner-launched route helper whose pipes are the master's stdio.
    pub(super) connector: Option<Child>,
    pub(super) recovery: Option<recovery::Recovery>,
    pub(super) socket: Option<Stamp>,
    pub(super) closing: bool,
    pub(super) _pin: trust_store::Snapshot,
    pub(super) retirement: Option<crate::owner::retirement::Retirement>,
    pub(super) master_record: Option<crate::owner::retirement::Instance>,
    pub(super) connector_record: Option<crate::owner::retirement::Instance>,
    /// A credential master's published control path; cleared before reap.
    pub(super) published: Option<crate::transport::credential::MuxPath>,
}
