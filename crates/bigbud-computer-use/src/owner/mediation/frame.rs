//! Mediated MCP `tools/call` request frames: strict JSON-RPC 2.0 shape in,
//! owner-serialized bytes out. Only this module's encoding is forwarded, so a
//! frame can never reach the Driver with fields mediation did not check.
use super::json_strict::{StrictRefusal, parse_strict};
use super::profile::Tool;
use crate::owner::admission::limits::{MAX_REQUEST_ID_CHARS, MAX_TOOL_CALL_FRAME_BYTES};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameRefusal {
    Json(StrictRefusal),
    /// Not exactly `{jsonrpc:"2.0", id, method:"tools/call", params:{name, arguments}}`.
    Shape,
    /// A tool outside the frozen 0.38 profile.
    UnknownTool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    /// Unsigned integer or bounded non-empty string. Dispatch replaces it
    /// with an owner-assigned wire id and returns the caller's for mapping.
    pub id: Value,
    pub tool: Tool,
    pub arguments: Map<String, Value>,
}

fn exact_keys(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn valid_id(id: &Value) -> bool {
    match id {
        Value::Number(number) => number.is_u64(),
        Value::String(text) => {
            !text.is_empty() && text.encode_utf16().count() <= MAX_REQUEST_ID_CHARS
        }
        _ => false,
    }
}

pub fn parse_tool_call(bytes: &[u8]) -> Result<ToolCall, FrameRefusal> {
    let value = parse_strict(bytes, MAX_TOOL_CALL_FRAME_BYTES).map_err(FrameRefusal::Json)?;
    let Value::Object(mut request) = value else {
        return Err(FrameRefusal::Shape);
    };
    if !exact_keys(&request, &["jsonrpc", "id", "method", "params"])
        || request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || request.get("method").and_then(Value::as_str) != Some("tools/call")
    {
        return Err(FrameRefusal::Shape);
    }
    let id = request.remove("id").ok_or(FrameRefusal::Shape)?;
    let Some(Value::Object(mut params)) = request.remove("params") else {
        return Err(FrameRefusal::Shape);
    };
    if !valid_id(&id) || !exact_keys(&params, &["name", "arguments"]) {
        return Err(FrameRefusal::Shape);
    }
    let name = params.remove("name").ok_or(FrameRefusal::Shape)?;
    let tool = name
        .as_str()
        .ok_or(FrameRefusal::Shape)
        .and_then(|name| Tool::from_name(name).ok_or(FrameRefusal::UnknownTool))?;
    let Some(Value::Object(arguments)) = params.remove("arguments") else {
        return Err(FrameRefusal::Shape);
    };
    Ok(ToolCall {
        id,
        tool,
        arguments,
    })
}

/// The only bytes forwarded to the Driver for a mediated call.
pub fn encode_tool_call(call: &ToolCall) -> Result<Vec<u8>, FrameRefusal> {
    let mut params = Map::new();
    params.insert("name".into(), Value::String(call.tool.name().into()));
    params.insert("arguments".into(), Value::Object(call.arguments.clone()));
    let mut request = Map::new();
    request.insert("jsonrpc".into(), Value::String("2.0".into()));
    request.insert("id".into(), call.id.clone());
    request.insert("method".into(), Value::String("tools/call".into()));
    request.insert("params".into(), Value::Object(params));
    serde_json::to_vec(&Value::Object(request)).map_err(|_| FrameRefusal::Shape)
}
