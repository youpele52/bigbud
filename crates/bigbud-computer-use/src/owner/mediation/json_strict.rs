//! Bounded strict JSON for mediated MCP frames. `serde_json` keeps the last
//! of duplicate object keys; mediation refuses them instead, comparing keys
//! after escape decoding (`"p\u0069d"` duplicates `"pid"`), so no frame can
//! carry two readings of one field. The size bound is checked before parsing.
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrictRefusal {
    Oversized,
    Malformed,
    DuplicateKey,
}

pub fn parse_strict(bytes: &[u8], max_bytes: usize) -> Result<Value, StrictRefusal> {
    if bytes.len() > max_bytes {
        return Err(StrictRefusal::Oversized);
    }
    let value = serde_json::from_slice(bytes).map_err(|_| StrictRefusal::Malformed)?;
    // The bytes are now known to be well-formed JSON, so a structural scan
    // that only tracks strings, brackets, commas and colons is exact.
    if has_duplicate_key(bytes).ok_or(StrictRefusal::Malformed)? {
        return Err(StrictRefusal::DuplicateKey);
    }
    Ok(value)
}

/// `None` only if a string escape cannot be decoded (not reachable after a
/// successful `serde_json` parse; treated as malformed).
fn has_duplicate_key(bytes: &[u8]) -> Option<bool> {
    let mut stack: Vec<Option<HashSet<String>>> = Vec::new();
    let mut expect_key = false;
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        match byte {
            b'"' => {
                let (text, next) = decode_string(bytes, index)?;
                index = next;
                if expect_key {
                    if let Some(Some(keys)) = stack.last_mut()
                        && !keys.insert(text)
                    {
                        return Some(true);
                    }
                    expect_key = false;
                }
                continue;
            }
            b'{' => {
                stack.push(Some(HashSet::new()));
                expect_key = true;
            }
            b'[' => {
                stack.push(None);
                expect_key = false;
            }
            b'}' | b']' => {
                stack.pop();
                expect_key = false;
            }
            b',' => expect_key = matches!(stack.last(), Some(Some(_))),
            b':' => expect_key = false,
            _ => {}
        }
        index += 1;
    }
    Some(false)
}

/// Decodes the JSON string starting at `bytes[start] == '"'`; returns the
/// text and the index just past the closing quote.
fn decode_string(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let mut units: Vec<u16> = Vec::new();
    let mut raw: Vec<u8> = Vec::new();
    let flush = |raw: &mut Vec<u8>, units: &mut Vec<u16>| -> Option<()> {
        units.extend(std::str::from_utf8(raw).ok()?.encode_utf16());
        raw.clear();
        Some(())
    };
    let mut index = start + 1;
    loop {
        let byte = *bytes.get(index)?;
        match byte {
            b'"' => {
                flush(&mut raw, &mut units)?;
                return Some((String::from_utf16(&units).ok()?, index + 1));
            }
            b'\\' => {
                flush(&mut raw, &mut units)?;
                let escape = *bytes.get(index + 1)?;
                let unit = match escape {
                    b'"' => u16::from(b'"'),
                    b'\\' => u16::from(b'\\'),
                    b'/' => u16::from(b'/'),
                    b'b' => 0x08,
                    b'f' => 0x0c,
                    b'n' => u16::from(b'\n'),
                    b'r' => u16::from(b'\r'),
                    b't' => u16::from(b'\t'),
                    b'u' => {
                        let hex = std::str::from_utf8(bytes.get(index + 2..index + 6)?).ok()?;
                        index += 4;
                        u16::from_str_radix(hex, 16).ok()?
                    }
                    _ => return None,
                };
                units.push(unit);
                index += 2;
            }
            _ => {
                raw.push(byte);
                index += 1;
            }
        }
    }
}
