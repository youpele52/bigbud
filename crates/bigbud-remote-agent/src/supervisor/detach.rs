use super::{Subscribers, Writer, io_helpers};
use bigbud_protocol::v1;
use std::io;

/// Idempotent subscription removal only; no PTY/session lookup, signal or retention change.
pub(super) fn detach(
    subscribers: &Subscribers,
    writer: &Writer,
    request: v1::PtyDetachRequest,
) -> io::Result<()> {
    let valid = !request.request_id.is_empty()
        && request.request_id.len() <= 256
        && !request.pty_id.is_empty()
        && request.pty_id.len() <= 256
        && request
            .pty_id
            .bytes()
            .all(|byte| (0x20..=0x7e).contains(&byte));
    if valid {
        // close() fences broadcasts that already cloned this subscription. Queued output
        // precedes the acknowledgement on the same bounded writer; other PTYs are untouched.
        io_helpers::remove_subscriber(subscribers, &request.pty_id, writer)?;
    }
    io_helpers::write_responses(
        writer,
        vec![v1::Frame {
            payload: Some(v1::frame::Payload::PtyDetachResponse(
                v1::PtyDetachResponse {
                    request_id: request.request_id,
                    pty_id: request.pty_id,
                    accepted: valid,
                    error_code: if valid {
                        String::new()
                    } else {
                        "PTY_DETACH_INVALID".to_owned()
                    },
                    error_message: if valid {
                        String::new()
                    } else {
                        "Invalid detach identity.".to_owned()
                    },
                },
            )),
        }],
    )
}
