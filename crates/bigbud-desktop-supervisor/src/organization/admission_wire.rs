use prost::encoding::{WireType, decode_key, decode_varint, skip_field};

#[derive(Clone, Copy)]
enum Kind {
    Frame,
    Hello,
    Limits,
    Begin,
    Policy,
    Page,
    End,
    Fact,
    Row,
    Settings,
    Receipt,
    Heartbeat,
}

// Reject duplicate known singular fields before prost can merge/normalize them.
// Unknown fields remain forward compatible; only Page.rows is repeated.
fn schema(kind: Kind, tag: u32) -> Option<(WireType, Option<Kind>, bool)> {
    use Kind::*;
    use WireType::{LengthDelimited as Bytes, Varint as Uint};
    let (wire, child) = match (kind, tag) {
        (Frame, 1) => (Bytes, None),
        (Frame, 2) => (Uint, None),
        (Frame, 3) => (Bytes, Some(Hello)),
        (Frame, 4) => (Bytes, Some(Begin)),
        (Frame, 5) => (Bytes, Some(Page)),
        (Frame, 6) => (Bytes, Some(End)),
        (Frame, 7) => (Bytes, Some(Fact)),
        (Frame, 8) => (Bytes, Some(Receipt)),
        (Frame, 9) => (Bytes, Some(Heartbeat)),
        (Frame, 10) => (Bytes, Some(Policy)),
        (Heartbeat, 1) => (Uint, None),
        (Policy, 4) => (Bytes, Some(Settings)),
        (Settings, 1..=8) | (Receipt, 2..=5) => (Uint, None),
        (Receipt, 1) => (Bytes, None),
        (Hello, 1..=2) | (Limits, 1..=6) | (Policy, 1 | 3) => (Uint, None),
        (Hello, 3) | (Policy, 2) => (Bytes, None),
        (Hello, 4) => (Bytes, Some(Limits)),
        (Begin, 1) | (Page, 1) | (End, 1 | 4) => (Bytes, None),
        (Begin, 2..=3) | (Page, 2) | (End, 2..=3 | 5) => (Uint, None),
        (Begin, 4) => (Bytes, Some(Policy)),
        (Page, 3) => (Bytes, Some(Row)),
        (Fact, 1..=2 | 4) => (Uint, None),
        (Fact, 3) => (Bytes, Some(Row)),
        (Row, 1 | 11) => (Bytes, None),
        (Row, 2..=10 | 12..=17) => (Uint, None),
        _ => return None,
    };
    Some((wire, child, matches!((kind, tag), (Page, 3))))
}

fn validate(mut bytes: &[u8], kind: Kind) -> bool {
    let mut seen = [false; 18];
    let mut payload = false;
    while !bytes.is_empty() {
        let Ok((tag, wire)) = decode_key(&mut bytes) else {
            return false;
        };
        if let Some((expected, child, repeated)) = schema(kind, tag) {
            let Some(slot) = seen.get_mut(tag as usize) else {
                return false;
            };
            if wire != expected || (*slot && !repeated) {
                return false;
            }
            *slot = true;
            if matches!(kind, Kind::Frame) && tag >= 3 {
                if payload {
                    return false;
                }
                payload = true;
            }
            if let Some(child) = child {
                let Ok(length) = decode_varint(&mut bytes) else {
                    return false;
                };
                let Ok(length) = usize::try_from(length) else {
                    return false;
                };
                let Some((nested, rest)) = bytes.split_at_checked(length) else {
                    return false;
                };
                if !validate(nested, child) {
                    return false;
                }
                bytes = rest;
                continue;
            }
        }
        if skip_field(wire, tag, &mut bytes, Default::default()).is_err() {
            return false;
        }
    }
    !matches!(kind, Kind::Frame) || (seen[1] && seen[2] && payload)
}

pub fn valid_envelope(bytes: &[u8]) -> bool {
    validate(bytes, Kind::Frame)
}
