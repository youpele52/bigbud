use super::{Binding, PrivatePaths, Stamp, recovery, trust_store};
use std::process::Child;

pub(super) struct Master {
    pub(super) binding: Binding,
    pub(super) paths: PrivatePaths,
    pub(super) child: Option<Child>,
    /// The owner-launched route helper whose pipes are the master's stdio.
    pub(super) connector: Option<Child>,
    pub(super) recovery: Option<recovery::Recovery>,
    pub(super) socket: Option<Stamp>,
    pub(super) closing: bool,
    pub(super) _pin: trust_store::Snapshot,
    pub(super) retirement: Option<crate::owner::retirement::Retirement>,
    pub(super) master_record: Option<crate::owner::retirement::Instance>,
    pub(super) connector_record: Option<crate::owner::retirement::Instance>,
}
