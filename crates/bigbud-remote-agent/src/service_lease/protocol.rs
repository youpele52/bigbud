//! Private wire projection, separate from bootstrap and owning process state.
use super::{Binding, Error, Result, Snapshot, State};
use bigbud_protocol::service_lease::v1 as lease;
use bigbud_protocol::v1::{Frame, frame::Payload};
pub(super) fn binding(value: Option<lease::Binding>) -> Result<Binding> {
    let value = value.ok_or(Error::Invalid)?;
    let result = Binding {
        authority: value.authority,
        installation: value.installation,
        native_epoch: value.native_epoch,
        nonce: value.nonce,
        publication_sha256: value
            .publication_sha256
            .try_into()
            .map_err(|_| Error::Invalid)?,
        executable_sha256: value
            .executable_sha256
            .try_into()
            .map_err(|_| Error::Invalid)?,
        assets_sha256: value.assets_sha256.try_into().map_err(|_| Error::Invalid)?,
        guard_sha256: value.guard_sha256.try_into().map_err(|_| Error::Invalid)?,
        configuration_sha256: value
            .configuration_sha256
            .try_into()
            .map_err(|_| Error::Invalid)?,
    };
    result.validate()?;
    Ok(result)
}
fn project(value: Binding) -> lease::Binding {
    lease::Binding {
        authority: value.authority,
        installation: value.installation,
        native_epoch: value.native_epoch,
        nonce: value.nonce,
        publication_sha256: value.publication_sha256.to_vec(),
        executable_sha256: value.executable_sha256.to_vec(),
        assets_sha256: value.assets_sha256.to_vec(),
        configuration_sha256: value.configuration_sha256.to_vec(),
        guard_sha256: value.guard_sha256.to_vec(),
    }
}
fn controller(value: super::Controller) -> lease::Controller {
    lease::Controller {
        pid: value.pid,
        boot: value.boot,
        started: value.started,
    }
}
pub(super) fn response(id: String, snapshot: Snapshot, generation: u64) -> lease::Response {
    lease::Response {
        request_id: id,
        accepted: true,
        state: match snapshot.state {
            State::Spawned => "spawned",
            // Not "spawned": existing clients fail closed until the successor attaches.
            State::Attaching => "attaching",
            State::Exited => "exited",
            State::Uncertain => "uncertain",
            State::Cancelled => "cancelled",
        }
        .into(),
        error_code: String::new(),
        binding: Some(project(snapshot.binding)),
        generation,
        original_child_pid: snapshot.original_child_pid,
        original_controller: snapshot.original_controller.map(controller),
        current_controller: snapshot.current_controller.map(controller),
        previous_controller: snapshot.previous_controller.map(controller),
        bootstrap: Vec::new(),
    }
}
pub(super) fn refused(id: String, error: &Error) -> lease::Response {
    lease::Response {
        request_id: if valid_request_id(&id) {
            id
        } else {
            String::new()
        },
        accepted: false,
        state: if matches!(error, Error::Uncertain) {
            "uncertain"
        } else {
            "refused"
        }
        .into(),
        error_code: match error {
            Error::Occupied => "LEASE_OCCUPIED",
            Error::Uncertain => "LEASE_UNCERTAIN",
            Error::Unsupported => "LEASE_UNAVAILABLE",
            _ => "LEASE_REFUSED",
        }
        .into(),
        ..Default::default()
    }
}
pub(super) fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
pub fn is_request(value: &Payload) -> bool {
    matches!(
        value,
        Payload::ServiceLeaseStartRequest(_)
            | Payload::ServiceLeaseStatusRequest(_)
            | Payload::ServiceLeaseResumeRequest(_)
            | Payload::ServiceLeaseControlRequest(_)
    )
}
pub(super) fn wrap(kind: u8, response: lease::Response) -> Frame {
    Frame {
        payload: Some(match kind {
            0 => Payload::ServiceLeaseStartResponse(Box::new(response)),
            1 => Payload::ServiceLeaseStatusResponse(Box::new(response)),
            2 => Payload::ServiceLeaseResumeResponse(Box::new(response)),
            _ => Payload::ServiceLeaseControlResponse(Box::new(response)),
        }),
    }
}
