use std::io::{self, Write};
use std::sync::Arc;

use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, write_frame};

use super::{Subscribers, Writer};

pub(super) fn add_subscriber(
    subscribers: &Subscribers,
    operation_id: &str,
    writer: Writer,
) -> io::Result<()> {
    subscribers
        .lock()
        .map_err(|_| io::Error::other("agent subscriber lock was poisoned"))?
        .entry(operation_id.to_owned())
        .or_default()
        .push(writer);
    Ok(())
}

pub(super) fn remove_subscriber(
    subscribers: &Subscribers,
    operation_id: &str,
    writer: &Writer,
) -> io::Result<()> {
    let mut subscribers = subscribers
        .lock()
        .map_err(|_| io::Error::other("agent subscriber lock was poisoned"))?;
    if let Some(writers) = subscribers.get_mut(operation_id) {
        writers.retain(|candidate| !Arc::ptr_eq(candidate, writer));
        if writers.is_empty() {
            subscribers.remove(operation_id);
        }
    }
    Ok(())
}

pub(super) fn remove_all_subscribers(subscribers: &Subscribers, operation_id: &str) {
    if let Ok(mut subscribers) = subscribers.lock() {
        subscribers.remove(operation_id);
    }
}

pub(super) fn broadcast_response(
    subscribers: &Subscribers,
    operation_id: &str,
    response: bigbud_protocol::v1::Frame,
) -> io::Result<()> {
    broadcast_responses(subscribers, operation_id, vec![response])
}

pub(super) fn broadcast_responses(
    subscribers: &Subscribers,
    operation_id: &str,
    responses: Vec<bigbud_protocol::v1::Frame>,
) -> io::Result<()> {
    let writers = subscribers
        .lock()
        .map_err(|_| io::Error::other("agent subscriber lock was poisoned"))?
        .get(operation_id)
        .cloned()
        .unwrap_or_default();
    let mut failed = Vec::new();
    for writer in writers {
        if write_responses(&writer, responses.clone()).is_err() {
            failed.push(writer);
        }
    }
    for writer in failed {
        remove_subscriber(subscribers, operation_id, &writer)?;
    }
    Ok(())
}

pub(super) fn write_protocol_error(writer: &Writer, error: &crate::SessionError) -> io::Result<()> {
    write_responses(writer, vec![crate::protocol_error_frame(error)])
}

pub(super) fn write_responses(
    writer: &Writer,
    responses: Vec<bigbud_protocol::v1::Frame>,
) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("agent writer lock was poisoned"))?;
    for response in responses {
        write_frame(&mut *writer, &response, DEFAULT_MAX_FRAME_BYTES)
            .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))?;
    }
    writer.flush()
}
