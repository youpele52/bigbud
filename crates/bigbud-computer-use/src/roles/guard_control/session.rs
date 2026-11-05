use crate::guard::GuardStatusSnapshot;
use bigbud_protocol::computer_use::{
    CONTROL_FRAME_BYTES, DATA_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, QUALIFICATION_PROFILE,
    common, control, v1, v1::frame::Payload,
};

pub(crate) const GUARD_ROLE: &str = "guard";
/// The trusted desktop host that owns the guard's lifeline and human Stop.
pub(crate) const PARENT_ROLE: &str = "human-control";

/// One classified inbound frame.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Request {
    /// Compatible parent Hello; nothing to send.
    Accepted,
    Status {
        request_id: String,
    },
    Stop {
        operation_id: String,
    },
    Refuse {
        request_id: String,
        code: &'static str,
    },
    /// The parent cannot speak this protocol: latch and shut down.
    Incompatible,
}

fn frame(payload: Payload) -> v1::Frame {
    v1::Frame {
        payload: Some(payload),
    }
}

/// The guard has no approved tuple or generation: those fields stay empty and
/// a peer must never treat this Hello as tuple agreement.
pub(crate) fn guard_hello(instance_id: &str) -> v1::Frame {
    frame(Payload::Hello(common::Hello {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        role: GUARD_ROLE.into(),
        qualification_profile: QUALIFICATION_PROFILE.into(),
        control_frame_bytes: CONTROL_FRAME_BYTES as u32,
        data_frame_bytes: DATA_FRAME_BYTES as u32,
        instance_id: instance_id.into(),
        ..Default::default()
    }))
}

fn parent_hello_compatible(hello: &common::Hello) -> bool {
    hello.protocol_major == PROTOCOL_MAJOR
        && hello.protocol_minor == PROTOCOL_MINOR
        && hello.role == PARENT_ROLE
        && hello.qualification_profile == QUALIFICATION_PROFILE
        && hello.control_frame_bytes == CONTROL_FRAME_BYTES as u32
        && hello.data_frame_bytes == DATA_FRAME_BYTES as u32
        && !hello.instance_id.is_empty()
}

fn refuse(request_id: &str, code: &'static str) -> Request {
    Request::Refuse {
        request_id: request_id.into(),
        code,
    }
}

/// `hello` records whether a compatible parent Hello was already accepted.
pub(crate) fn classify(frame: v1::Frame, hello: &mut bool) -> Request {
    let Some(payload) = frame.payload else {
        return refuse("", "invalid_request");
    };
    match payload {
        Payload::Hello(_) if *hello => refuse("", "duplicate_hello"),
        Payload::Hello(peer) if parent_hello_compatible(&peer) => {
            *hello = true;
            Request::Accepted
        }
        Payload::Hello(_) => Request::Incompatible,
        // Never refused, never gated on Hello.
        Payload::Stop(stop) => Request::Stop {
            operation_id: stop.operation_id,
        },
        Payload::Status(query) if !*hello => refuse(&query.request_id, "hello_required"),
        Payload::Status(query) => {
            let request_id = query.request_id.clone();
            let bare = control::Status {
                request_id: request_id.clone(),
                ..Default::default()
            };
            if query == bare && !request_id.is_empty() {
                Request::Status { request_id }
            } else {
                refuse(&request_id, "invalid_request")
            }
        }
        Payload::Resume(resume) => refuse(&resume.request_id, "resume_unavailable"),
        _ => refuse("", "unsupported"),
    }
}

pub(crate) fn protocol_error(request_id: &str, code: &str) -> v1::Frame {
    frame(Payload::ProtocolError(common::ProtocolError {
        request_id: request_id.into(),
        code: code.into(),
    }))
}

/// No roots are attached to the dev guard, so there is no settlement id.
pub(crate) fn revoked_frame(operation_id: &str, pause_epoch: u64) -> v1::Frame {
    frame(Payload::Revoked(control::Revoked {
        operation_id: operation_id.into(),
        pause_epoch,
        settlement_id: String::new(),
    }))
}

pub(crate) fn status_frame(request_id: &str, snapshot: Option<&GuardStatusSnapshot>) -> v1::Frame {
    let Some(snapshot) = snapshot else {
        return frame(Payload::Status(control::Status {
            request_id: request_id.into(),
            state: "starting".into(),
            ..Default::default()
        }));
    };
    let record = &snapshot.record;
    let state = if !snapshot.storage_ok {
        "storage_failed"
    } else if record.latched {
        "paused"
    } else {
        "unpaused"
    };
    let notice = record.notice.as_ref();
    frame(Payload::Status(control::Status {
        request_id: request_id.into(),
        state: state.into(),
        pause_epoch: record.pause_epoch,
        applied_revision: record
            .binding
            .as_ref()
            .map(|binding| binding.revision.clone())
            .unwrap_or_default(),
        episode_id: notice.map(|n| n.episode.clone()).unwrap_or_default(),
        notice_id: notice.map(|n| n.notice.clone()).unwrap_or_default(),
        notice_state: notice.map(|n| n.state.text().into()).unwrap_or_default(),
        retirement: if record.roots.is_empty() {
            "none_attached"
        } else {
            "retained"
        }
        .into(),
        input_state: if record.input_uncertain {
            "uncertain"
        } else {
            "known"
        }
        .into(),
        // The guard has no execution queue.
        queued_operations: 0,
    }))
}
