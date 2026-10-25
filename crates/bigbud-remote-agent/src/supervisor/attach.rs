use super::{Subscribers, Writer, io_helpers, subscription::Subscription};
use crate::AgentSession;
use bigbud_protocol::v1;
use std::io;
use std::sync::{Arc, Mutex};

pub(super) fn attach(
    sessions: &Arc<Mutex<AgentSession>>,
    subscribers: &Subscribers,
    writer: &Writer,
    payload: v1::frame::Payload,
) -> io::Result<()> {
    let (id, cursor) = match &payload {
        v1::frame::Payload::PtyAttachRequest(value) => (value.pty_id.clone(), value.after_sequence),
        v1::frame::Payload::ProcessAttachRequest(value) => {
            (value.operation_id.clone(), value.after_sequence)
        }
        _ => return Err(io::Error::other("unsupported attach")),
    };
    let prepared = {
        let mut session = sessions
            .lock()
            .map_err(|_| io::Error::other("session poisoned"))?;
        if !session.is_accepting_work() {
            drop(session);
            return io_helpers::write_protocol_error(writer, &crate::SessionError::Restarting);
        }
        let response = match payload {
            v1::frame::Payload::PtyAttachRequest(value) => session.handle_pty_attach(value),
            v1::frame::Payload::ProcessAttachRequest(value) => session.handle_process_attach(value),
            _ => return Err(io::Error::other("unsupported attach")),
        };
        response
            .map(|responses| {
                let live = io_helpers::attach_response_is_live(&responses)
                    || io_helpers::pty_attach_response_is_live(&responses);
                let cut = responses
                    .iter()
                    .filter_map(|frame| match &frame.payload {
                        Some(v1::frame::Payload::PtyAttachResponse(value)) => {
                            Some(value.next_sequence.saturating_sub(1))
                        }
                        Some(v1::frame::Payload::ProcessAttachResponse(value)) => {
                            Some(value.next_sequence.saturating_sub(1))
                        }
                        Some(v1::frame::Payload::ProcessOutput(value)) => Some(value.sequence),
                        _ => None,
                    })
                    .max()
                    .map_or(cursor, |cut| cut.max(cursor));
                (responses, live, cut)
            })
            .and_then(|(responses, live, cut)| {
                if !live {
                    return Ok((responses, None));
                }
                let mut entries = subscribers
                    .lock()
                    .map_err(|_| crate::SessionError::Pty("subscriber lock poisoned".to_owned()))?;
                let list = entries.entry(id.clone()).or_default();
                list.retain(|candidate| {
                    let keep =
                        !candidate.writer.is_closed() && !Arc::ptr_eq(&candidate.writer, writer);
                    if !keep {
                        candidate.close();
                    }
                    keep
                });
                if list.len() >= 8 {
                    return Err(crate::SessionError::Pty("subscriber limit".to_owned()));
                }
                let generation = Subscription::replay(Arc::clone(writer), cut);
                list.push(Arc::clone(&generation));
                Ok((responses, Some(generation)))
            })
    };
    match prepared {
        Ok((responses, generation)) => {
            let result = responses
                .into_iter()
                .enumerate()
                .try_for_each(|(_index, response)| {
                    writer.enqueue_response(&response)?;
                    #[cfg(test)]
                    super::test_hooks::replay_barrier(&id, _index);
                    Ok(())
                })
                .and_then(|()| {
                    generation
                        .as_ref()
                        .map_or(Ok(()), |generation| generation.finish_replay())
                });
            if result.is_err() {
                io_helpers::remove_subscriber(subscribers, &id, writer)?;
            }
            result
        }
        Err(error) => io_helpers::write_protocol_error(writer, &error),
    }
}
