//! Pure successor-recovery decisions. Every ambiguous observation stays uncertain.
// Only Linux kernel probes construct the observed variants.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// A bounded connect attempt. Only an explicit refusal proves "no listener".
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) enum Connect {
    Accepted,
    Refused,
    Unknown,
}
/// The recorded original child, compared by PID, boot and kernel start ticks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) enum Child {
    Original,
    /// Missing PID or changed kernel identity: this exact child is gone.
    Gone,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) struct GatewayObservation {
    pub child: Child,
    /// The recorded listener inode is still listening and held by the recorded child.
    pub holds: Option<bool>,
    pub connect: Connect,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) enum Gateway {
    /// Attach the successor to the original child; it still serves the recorded socket.
    Live,
    /// The original child and its listener are gone; only a fresh Start may follow.
    Gone,
    Uncertain,
}
pub(in crate::service_lease) fn gateway(observed: GatewayObservation) -> Gateway {
    match observed {
        GatewayObservation {
            child: Child::Original,
            holds: Some(true),
            connect: Connect::Accepted,
        } => Gateway::Live,
        GatewayObservation {
            child: Child::Gone,
            connect: Connect::Refused,
            ..
        } => Gateway::Gone,
        _ => Gateway::Uncertain,
    }
}

/// The upstream path left behind by a proven-dead controller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) enum StalePath {
    Absent,
    /// A private socket with exactly the recorded device/inode.
    Recorded(Connect),
    /// Anything else at the path: another inode, a symlink, a non-socket or foreign owner.
    Unrecorded,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) enum Stale {
    /// Nothing remains at the path.
    Clear,
    /// Unlink only after re-checking the exact recorded inode immediately beforehand.
    Unlink,
    /// Preserve for repair; never unlink a live, foreign or unprovable endpoint.
    Preserve,
}
pub(in crate::service_lease) fn stale(observed: StalePath) -> Stale {
    match observed {
        StalePath::Absent => Stale::Clear,
        StalePath::Recorded(Connect::Refused) => Stale::Unlink,
        _ => Stale::Preserve,
    }
}

/// The successor's newly published upstream endpoint.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) enum FreshPath {
    Absent,
    /// A sealed private socket; `held` compares its listener credentials to the controller.
    Sealed {
        connect: Connect,
        held: Option<bool>,
    },
    Unsealed,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::service_lease) enum Attach {
    /// Not yet published; stay unready without mutating anything.
    Pending,
    Attached,
    Uncertain,
}
pub(in crate::service_lease) fn attach(observed: FreshPath) -> Attach {
    match observed {
        FreshPath::Absent => Attach::Pending,
        FreshPath::Sealed {
            connect: Connect::Accepted,
            held: Some(true),
        } => Attach::Attached,
        _ => Attach::Uncertain,
    }
}
