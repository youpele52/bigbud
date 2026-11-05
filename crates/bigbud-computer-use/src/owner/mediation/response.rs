//! Raw Driver `tools/call` responses, parsed only to be rebuilt by egress.
//! Nothing here is forwarded: text content is never read, and only the
//! structured payload and image items are handed to the projection.
use super::json_strict::{StrictRefusal, parse_strict};
use crate::owner::admission::limits::MAX_INGRESS_BYTES;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseRefusal {
    Json(StrictRefusal),
    /// Not a JSON-RPC 2.0 response with exactly one of `result`/`error`.
    Shape,
    /// The response answers a different request.
    IdMismatch,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub mime: String,
    pub base64: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResponse {
    /// A JSON-RPC error or `isError: true`.
    pub is_error: bool,
    pub structured: Option<Map<String, Value>>,
    pub images: Vec<Image>,
}

/// `wire_id` is the owner-assigned id the frame was forwarded with; only an
/// unsigned integer id equal to it answers this request.
pub fn parse_tool_response(bytes: &[u8], wire_id: u64) -> Result<ToolResponse, ResponseRefusal> {
    let value = parse_strict(bytes, MAX_INGRESS_BYTES).map_err(ResponseRefusal::Json)?;
    let Value::Object(mut response) = value else {
        return Err(ResponseRefusal::Shape);
    };
    if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || response.len() != 3 {
        return Err(ResponseRefusal::Shape);
    }
    if response.get("id").and_then(Value::as_u64) != Some(wire_id) {
        return Err(ResponseRefusal::IdMismatch);
    }
    if response.get("error").is_some_and(Value::is_object) {
        return Ok(ToolResponse {
            is_error: true,
            structured: None,
            images: Vec::new(),
        });
    }
    let Some(Value::Object(mut result)) = response.remove("result") else {
        return Err(ResponseRefusal::Shape);
    };
    let is_error = match result.get("isError") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(ResponseRefusal::Shape),
    };
    let structured = match result.remove("structuredContent") {
        None | Some(Value::Null) => None,
        Some(Value::Object(object)) => Some(object),
        Some(_) => return Err(ResponseRefusal::Shape),
    };
    let Some(Value::Array(content)) = result.remove("content") else {
        return Err(ResponseRefusal::Shape);
    };
    let mut images = Vec::new();
    for item in content {
        let Value::Object(mut item) = item else {
            return Err(ResponseRefusal::Shape);
        };
        match item.get("type").and_then(Value::as_str) {
            Some("image") => {
                let (Some(Value::String(mime)), Some(Value::String(base64))) =
                    (item.remove("mimeType"), item.remove("data"))
                else {
                    return Err(ResponseRefusal::Shape);
                };
                images.push(Image { mime, base64 });
            }
            Some(_) => {}
            None => return Err(ResponseRefusal::Shape),
        }
    }
    Ok(ToolResponse {
        is_error,
        structured,
        images,
    })
}
