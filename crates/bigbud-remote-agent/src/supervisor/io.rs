use std::io;
use std::sync::Arc;

use super::{Subscribers, Writer};

pub(super) fn attach_response_is_live(responses: &[bigbud_protocol::v1::Frame]) -> bool {
    responses.iter().any(|response| {
        matches!(
            &response.payload,
            Some(bigbud_protocol::v1::frame::Payload::ProcessAttachResponse(status))
                if status.state == "accepted" || status.state == "running" || status.state == "cancelling"
        )
    })
}

pub(super) fn pty_attach_response_is_live(responses: &[bigbud_protocol::v1::Frame]) -> bool {
    responses.iter().any(|response| {
        matches!(
            &response.payload,
            Some(bigbud_protocol::v1::frame::Payload::PtyAttachResponse(status))
                if status.state == "running"
        )
    })
}

pub(super) fn add_subscriber(
    subscribers: &Subscribers,
    operation_id: &str,
    writer: Writer,
) -> io::Result<()> {
    let mut subscribers = subscribers
        .lock()
        .map_err(|_| io::Error::other("agent subscriber lock was poisoned"))?;
    let writers = subscribers.entry(operation_id.to_owned()).or_default();
    writers.retain(|subscription| !subscription.writer.is_closed());
    if writers
        .iter()
        .any(|candidate| Arc::ptr_eq(&candidate.writer, &writer))
    {
        return Ok(());
    }
    if writers.len() >= 8 {
        return Err(io::Error::other("subscriber count exceeded"));
    }
    writers.push(super::subscription::Subscription::live(writer));
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
        writers.retain(|candidate| {
            if Arc::ptr_eq(&candidate.writer, writer) {
                candidate.close();
                false
            } else {
                true
            }
        });
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

pub(super) fn remove_connection(subscribers: &Subscribers, writer: &Writer) -> io::Result<()> {
    let mut subscribers = subscribers
        .lock()
        .map_err(|_| io::Error::other("subscriber lock poisoned"))?;
    subscribers.retain(|_, writers| {
        writers.retain(|candidate| {
            let keep = !Arc::ptr_eq(&candidate.writer, writer) && !candidate.writer.is_closed();
            if !keep {
                candidate.close();
            }
            keep
        });
        !writers.is_empty()
    });
    Ok(())
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
    for subscription in writers {
        if responses
            .iter()
            .try_for_each(|response| subscription.deliver(response))
            .is_err()
        {
            subscription.writer.cancel();
            failed.push(Arc::clone(&subscription.writer));
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
    for response in responses {
        writer.enqueue_response(&response)?;
    }
    Ok(())
}
