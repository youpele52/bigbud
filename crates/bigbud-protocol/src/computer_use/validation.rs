use super::{
    CONTROL_FRAME_BYTES, Channel, DATA_FRAME_BYTES, FrameError, PROTOCOL_MAJOR, PROTOCOL_MINOR,
    QUALIFICATION_PROFILE, common, v1,
};
use v1::frame::Payload;

fn texts(values: &[&str]) -> bool {
    values
        .iter()
        .all(|value| value.len() <= 128 && !value.contains('\0'))
}
fn digest(value: &[u8]) -> bool {
    value.len() == 32
}

/// Structural bounds, not operation/policy/role authorization. Authentication
/// and stateful admission are separate mandatory owner responsibilities.
pub fn validate_frame(frame: &v1::Frame, channel: Channel) -> Result<(), FrameError> {
    let payload = frame.payload.as_ref().ok_or(FrameError::Invalid)?;
    let data = matches!(
        payload,
        Payload::MediatedCall(_) | Payload::OperationResult(_)
    );
    if data != (channel == Channel::Data)
        && !matches!(payload, Payload::Hello(_) | Payload::ProtocolError(_))
    {
        return Err(FrameError::Channel);
    }
    let valid = match payload {
        Payload::Hello(v) => texts(&[
            &v.tuple_digest,
            &v.role,
            &v.owner_generation,
            &v.worker_generation,
            &v.qualification_profile,
            &v.instance_id,
        ]),
        Payload::ApplyPolicy(v) => {
            texts(&[&v.request_id, &v.authority_id, &v.revision, &v.fence_id])
                && digest(&v.digest)
                && v.canonical_policy.len() <= 48 * 1024
        }
        Payload::PolicyAcknowledged(v) => {
            texts(&[&v.request_id, &v.authority_id, &v.revision, &v.fence_id]) && digest(&v.digest)
        }
        Payload::BeginEpisode(v) => texts(&[
            &v.request_id,
            &v.caller_id,
            &v.provider_generation,
            &v.runtime_mode_revision,
            &v.participation_id,
        ]),
        Payload::AdmitOperation(v) => {
            texts(&[
                &v.operation_id,
                &v.caller_id,
                &v.episode_id,
                &v.native_session_id,
                &v.policy_revision,
                &v.owner_generation,
                &v.worker_generation,
                &v.target_ref,
                &v.observation_ref,
                &v.provider_generation,
                &v.runtime_mode_revision,
            ]) && digest(&v.request_digest)
                && v.canonical_plan.len() <= 48 * 1024
                && (10_000..=3_600_000).contains(&v.timeout_ms)
        }
        Payload::Admission(v) => texts(&[&v.operation_id, &v.ticket, &v.native_session_id]),
        Payload::MediatedCall(v) => {
            texts(&[&v.ticket])
                && !v.mcp_frame.is_empty()
                && v.mcp_frame.len() <= DATA_FRAME_BYTES - 1024
        }
        Payload::Stop(v) => texts(&[&v.operation_id, &v.desktop_scope]),
        Payload::Revoked(v) => texts(&[&v.operation_id, &v.settlement_id]),
        Payload::Resume(v) => texts(&[
            &v.request_id,
            &v.challenge,
            &v.authority_id,
            &v.policy_revision,
            &v.episode_id,
        ]),
        Payload::SurfaceLease(v) => texts(&[
            &v.owner_generation,
            &v.host_identity,
            &v.document_generation,
            &v.challenge,
            &v.interactive_desktop_identity,
            &v.qualification_id,
        ]),
        Payload::WarningPresented(v) => texts(&[
            &v.episode_id,
            &v.notice_id,
            &v.document_generation,
            &v.challenge,
        ]),
        Payload::Status(v) => {
            texts(&[
                &v.request_id,
                &v.state,
                &v.applied_revision,
                &v.episode_id,
                &v.notice_id,
                &v.notice_state,
                &v.retirement,
                &v.input_state,
            ]) && v.queued_operations <= 32
        }
        Payload::OperationResult(v) => {
            texts(&[&v.operation_id, &v.completion, &v.code, &v.capture_error])
                && matches!(
                    v.completion.as_str(),
                    "not_started" | "completed" | "unknown"
                )
                && v.projected_result.len() <= DATA_FRAME_BYTES - 1024
        }
        Payload::LookupOperation(v) => {
            texts(&[&v.caller_id, &v.operation_id]) && digest(&v.request_digest)
        }
        Payload::RevokeCaller(v) => texts(&[
            &v.caller_id,
            &v.provider_generation,
            &v.runtime_mode_revision,
        ]),
        Payload::Settlement(v) => texts(&[&v.settlement_id, &v.retirement, &v.input_state]),
        Payload::ProtocolError(v) => texts(&[&v.request_id, &v.code]),
    };
    if !valid {
        return Err(FrameError::Invalid);
    }
    Ok(())
}

/// Exact tuple/profile agreement is necessary, never sufficient for admission.
/// The selected manifest must already have independently qualified this host.
pub fn validate_hello(hello: &common::Hello, tuple_digest: &str) -> Result<(), FrameError> {
    if hello.protocol_major != PROTOCOL_MAJOR
        || hello.protocol_minor != PROTOCOL_MINOR
        || hello.tuple_digest != tuple_digest
        || tuple_digest.len() != 64
        || !tuple_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !matches!(
            hello.role.as_str(),
            "guard" | "owner" | "worker" | "server" | "human-control"
        )
        || hello.qualification_profile != QUALIFICATION_PROFILE
        || hello.control_frame_bytes != CONTROL_FRAME_BYTES as u32
        || hello.data_frame_bytes != DATA_FRAME_BYTES as u32
        || hello.instance_id.is_empty()
        || hello.owner_generation.is_empty()
    {
        return Err(FrameError::Incompatible);
    }
    Ok(())
}
