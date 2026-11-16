//! Receipt-only bounded shape: no unbounded serde_json::Value deserialization.
use crate::service_lease::{Error, Result};
use serde_core::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;
struct Seed<'a> {
    nodes: &'a mut usize,
    strings: &'a mut usize,
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
        *self.nodes += 1;
        if *self.nodes > 400_000 || self.depth > 12 {
            return Err(de::Error::custom("receipt shape budget"));
        }
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded assets receipt")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        Ok(Value::Number(Number::from(v)))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        Ok(Value::Number(Number::from(v)))
    }
    fn visit_f64<E: de::Error>(self, _v: f64) -> std::result::Result<Value, E> {
        Err(E::custom("receipt floating point refused"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        *self.strings += v.len();
        if v.len() > 512 || *self.strings > 8 * 1024 * 1024 {
            return Err(E::custom("receipt string budget"));
        }
        Ok(Value::String(v.into()))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        let mut result = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if key.len() > 64 || result.len() >= 32 || result.contains_key(&key) {
                return Err(de::Error::custom(
                    "receipt object budget or duplicate field",
                ));
            }
            let v = map.next_value_seed(Seed {
                nodes: self.nodes,
                strings: self.strings,
                depth: self.depth + 1,
            })?;
            result.insert(key, v);
        }
        Ok(Value::Object(result))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
        let mut result = Vec::new();
        while let Some(v) = seq.next_element_seed(Seed {
            nodes: self.nodes,
            strings: self.strings,
            depth: self.depth + 1,
        })? {
            if result.len() >= 16385 {
                return Err(de::Error::custom("receipt entry budget"));
            }
            result.push(v);
        }
        Ok(Value::Array(result))
    }
}
pub(super) fn parse(raw: &[u8]) -> Result<Value> {
    if raw.is_empty() || raw.len() > 8 * 1024 * 1024 {
        return Err(Error::Invalid);
    }
    let mut d = serde_json::Deserializer::from_slice(raw);
    let mut nodes = 0;
    let mut strings = 0;
    let value = Seed {
        nodes: &mut nodes,
        strings: &mut strings,
        depth: 0,
    }
    .deserialize(&mut d)
    .map_err(|_| Error::Invalid)?;
    d.end().map_err(|_| Error::Invalid)?;
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn budgets_precede_retaining_unbounded_or_duplicate_receipt_shapes() {
        assert!(parse(br#"{"same":1,"same":2}"#).is_err());
        assert!(parse(format!("[{}0]", "0,".repeat(16385)).as_bytes()).is_err());
        assert!(parse(format!("\"{}\"", "x".repeat(513)).as_bytes()).is_err());
        assert!(parse(br#"{"valid":[1,"2",true]}"#).is_ok());
    }
}
