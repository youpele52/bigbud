//! Hello negotiation: incompatible peers are rejected before any operation.
//! Identity is the authenticated channel plus generation strings, never a
//! claimed PID. Limits negotiate down to the minimum and never above frozen.
use super::limits::{CONTROL_FRAME_BYTES, DATA_FRAME_BYTES};
use crate::{Role, guard::record::valid_id};

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloFields {
    pub major: u32,
    pub minor: u32,
    pub tuple_digest: String,
    pub role: String,
    pub owner_generation: String,
    pub worker_generation: String,
    pub qualification_profile: String,
    pub control_frame_bytes: u32,
    pub data_frame_bytes: u32,
    pub instance_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelloRefusal {
    Major,
    Tuple,
    Role,
    Generation,
    Profile,
    Limits,
    Instance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Negotiated {
    pub minor: u32,
    pub control_frame_bytes: u32,
    pub data_frame_bytes: u32,
    pub owner_generation: String,
    pub worker_generation: String,
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Guard => "guard",
        Role::Owner => "owner",
        Role::Worker => "worker",
        Role::Broker => "broker",
    }
}

/// `local` is this process's own Hello; `peer` arrived on an authenticated,
/// role-bound channel whose expected role is `expected`.
pub fn negotiate(
    local: &HelloFields,
    peer: &HelloFields,
    expected: Role,
) -> Result<Negotiated, HelloRefusal> {
    // A local Hello claiming a minor this build does not implement is a bug.
    if peer.major != PROTOCOL_MAJOR || local.major != PROTOCOL_MAJOR || local.minor > PROTOCOL_MINOR
    {
        return Err(HelloRefusal::Major);
    }
    if peer.tuple_digest.len() != 64
        || !peer
            .tuple_digest
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        || peer.tuple_digest != local.tuple_digest
    {
        return Err(HelloRefusal::Tuple);
    }
    if peer.role != role_name(expected) {
        return Err(HelloRefusal::Role);
    }
    if !valid_id(&peer.owner_generation)
        || !valid_id(&peer.worker_generation)
        || peer.owner_generation != local.owner_generation
        || peer.worker_generation != local.worker_generation
    {
        return Err(HelloRefusal::Generation);
    }
    if !valid_id(&peer.qualification_profile)
        || peer.qualification_profile != local.qualification_profile
    {
        return Err(HelloRefusal::Profile);
    }
    if !valid_id(&peer.instance_id) || peer.instance_id == local.instance_id {
        return Err(HelloRefusal::Instance);
    }
    let control = peer.control_frame_bytes.min(local.control_frame_bytes);
    let data = peer.data_frame_bytes.min(local.data_frame_bytes);
    if control == 0 || data == 0 || control > CONTROL_FRAME_BYTES || data > DATA_FRAME_BYTES {
        return Err(HelloRefusal::Limits);
    }
    Ok(Negotiated {
        // `local.minor` was checked <= PROTOCOL_MINOR above.
        minor: peer.minor.min(local.minor),
        control_frame_bytes: control,
        data_frame_bytes: data,
        owner_generation: peer.owner_generation.clone(),
        worker_generation: peer.worker_generation.clone(),
    })
}
