use super::{error, mapping, wrap};
use crate::monitor_v1 as v1;
use bigbud_system::{
    inventory::{Cursor, Query, QueryError, SortKey},
    lifecycle::Service,
};
use std::time::Instant;

pub(super) fn query(service: &mut Service, request: v1::ProcessQuery, now: Instant) -> v1::Frame {
    if request.name.len() > 256
        || request.status.len() > 256
        || request.limit == 0
        || request.limit > 100
    {
        return error(request.request_id, 0, "invalid", "invalid process query");
    }
    let sort = match request.sort.as_str() {
        "cpu" | "" => SortKey::Cpu,
        "memory" => SortKey::Memory,
        "name" => SortKey::Name,
        "pid" => SortKey::Pid,
        _ => return error(request.request_id, 0, "invalid", "invalid sort key"),
    };
    let query = Query {
        name: (!request.name.is_empty()).then_some(request.name),
        pid: request.pid,
        status: (!request.status.is_empty()).then_some(request.status),
        sort,
        descending: request.descending,
        limit: request.limit as usize,
    };
    let cursor = (request.cursor_generation != 0).then_some(Cursor {
        generation: request.cursor_generation,
        digest: request.cursor_digest,
        offset: request.cursor_offset as usize,
    });
    match service.query(&query, cursor.as_ref(), now) {
        Ok(page) => wrap(v1::frame::Payload::ProcessPage(mapping::page(
            page,
            request.request_id,
        ))),
        Err(err) => {
            let code = match err {
                QueryError::Invalid => "invalid",
                QueryError::StaleQuery => "stale-query",
                QueryError::Busy => "busy",
                QueryError::Deadline => "deadline",
            };
            error(request.request_id, 0, code, &err.to_string())
        }
    }
}
