//! Library JSON traversal retains only bounded predicate booleans, never registry trees.
use super::super::{Error, Result};
use super::model::{Model, Predicate, Selection};
use serde_core::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::fmt;
const MAX_NODES: usize = 262_144;
enum Plan<'a> {
    Root(&'a Model),
    Row(&'a Selection),
    Ignore,
}
struct Capture<'a> {
    plan: Plan<'a>,
    all: Vec<Option<bool>>,
    selected: Vec<Option<bool>>,
    key: Option<bool>,
}
impl<'a> Capture<'a> {
    fn new(plan: Plan<'a>) -> Self {
        let count = match &plan {
            Plan::Root(model) => model.all.len(),
            Plan::Row(rule) => rule.all.len(),
            Plan::Ignore => 0,
        };
        let selected = match &plan {
            Plan::Root(model) => model.select.len(),
            _ => 0,
        };
        Self {
            plan,
            all: vec![None; count],
            selected: vec![None; selected],
            key: None,
        }
    }
    fn rules(&self) -> &[Predicate] {
        match &self.plan {
            Plan::Root(model) => &model.all,
            Plan::Row(rule) => &rule.all,
            _ => &[],
        }
    }
    fn prefix(&self, path: &[String]) -> bool {
        self.rules().iter().any(|rule| rule.path.starts_with(path))
            || match &self.plan {
                Plan::Root(model) => model.select.iter().any(|rule| rule.path.starts_with(path)),
                Plan::Row(rule) => path.len() == 1 && path.first() == Some(&rule.key),
                Plan::Ignore => false,
            }
    }
    fn observe<E: de::Error>(
        &mut self,
        path: &[String],
        matches: impl Fn(&Value) -> bool,
    ) -> std::result::Result<(), E> {
        for index in 0..self.all.len() {
            let rule = self
                .rules()
                .get(index)
                .ok_or_else(|| E::custom("guard projection index"))?;
            if rule.path == path {
                let matched = rule.values.iter().any(&matches);
                let slot = self
                    .all
                    .get_mut(index)
                    .ok_or_else(|| E::custom("guard projection index"))?;
                if slot.replace(matched).is_some() {
                    return Err(E::custom("duplicate selected guard field"));
                }
            }
        }
        if let Plan::Row(rule) = &self.plan
            && path.len() == 1
            && path.first() == Some(&rule.key)
            && self
                .key
                .replace(matches(&Value::String(rule.value.clone())))
                .is_some()
        {
            return Err(E::custom("duplicate guard selector key"));
        }

        Ok(())
    }
    fn complete(&self) -> bool {
        self.all.iter().all(|value| *value == Some(true))
            && self.selected.iter().all(|value| *value == Some(true))
    }
}
struct Seed<'a, 'b> {
    capture: &'a mut Capture<'b>,
    path: &'a mut Vec<String>,
    nodes: &'a mut usize,
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for Seed<'_, '_> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<(), D::Error> {
        *self.nodes += 1;
        if *self.nodes > MAX_NODES || self.depth > 32 {
            return Err(de::Error::custom("guard JSON traversal budget exceeded"));
        }
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed<'_, '_> {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("bounded guard JSON")
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<(), E> {
        self.capture
            .observe(self.path, |expected| expected.as_bool() == Some(value))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<(), E> {
        self.capture
            .observe(self.path, |expected| expected.as_u64() == Some(value))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<(), E> {
        self.capture.observe(self.path, |expected| {
            u64::try_from(value)
                .ok()
                .is_some_and(|n| expected.as_u64() == Some(n))
        })
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<(), E> {
        self.capture.observe(self.path, |expected| {
            value.is_finite()
                && (0.0..=9_007_199_254_740_991.0).contains(&value)
                && value.fract() == 0.0
                && expected.as_u64() == Some(value as u64)
        })
    }
    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<(), E> {
        self.capture
            .observe(self.path, |expected| expected.as_str() == Some(value))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<(), E> {
        self.capture.observe(self.path, |_| false)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<(), A::Error> {
        self.capture.observe(self.path, |_| false)?;
        let mut seen = std::collections::HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if key.len() > 256 {
                return Err(de::Error::custom("guard JSON key budget exceeded"));
            }
            self.path.push(key);
            if self.capture.prefix(self.path)
                && !seen.insert(
                    self.path
                        .last()
                        .cloned()
                        .ok_or_else(|| de::Error::custom("guard path"))?,
                )
            {
                return Err(de::Error::custom("duplicate selected guard branch"));
            }
            map.next_value_seed(Seed {
                capture: self.capture,
                path: self.path,
                nodes: self.nodes,
                depth: self.depth + 1,
            })?;
            self.path.pop();
        }
        Ok(())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> std::result::Result<(), A::Error> {
        self.capture.observe(self.path, |_| false)?;
        let selections = match &self.capture.plan {
            Plan::Root(model) => model
                .select
                .iter()
                .enumerate()
                .filter(|(_, rule)| rule.path == *self.path)
                .map(|(index, _)| index)
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        if selections.is_empty() {
            let mut ignored = Capture::new(Plan::Ignore);
            let mut path = Vec::new();
            while sequence
                .next_element_seed(Seed {
                    capture: &mut ignored,
                    path: &mut path,
                    nodes: self.nodes,
                    depth: self.depth + 1,
                })?
                .is_some()
            {}
            return Ok(());
        }
        // Multiple rules on the same array are deliberately refused; a single
        // bounded unique-key selection can express all of that row's predicates.
        if selections.len() != 1 {
            return Err(de::Error::custom("duplicate guard array plan"));
        }
        let index = *selections
            .first()
            .ok_or_else(|| de::Error::custom("guard array plan"))?;
        let Plan::Root(model) = &self.capture.plan else {
            return Err(de::Error::custom("guard array plan"));
        };
        let rule = model
            .select
            .get(index)
            .ok_or_else(|| de::Error::custom("guard array plan"))?;
        let mut rows = 0;
        let mut matches = 0;
        let mut valid = false;
        loop {
            let mut row = Capture::new(Plan::Row(rule));
            let mut path = Vec::new();
            if sequence
                .next_element_seed(Seed {
                    capture: &mut row,
                    path: &mut path,
                    nodes: self.nodes,
                    depth: self.depth + 1,
                })?
                .is_none()
            {
                break;
            }
            rows += 1;
            if rows > rule.maximum {
                return Err(de::Error::custom("guard selected array budget exceeded"));
            }
            if row.key == Some(true) {
                matches += 1;
                valid = row.complete();
            }
        }
        *self
            .capture
            .selected
            .get_mut(index)
            .ok_or_else(|| de::Error::custom("guard array plan"))? = Some(matches == 1 && valid);
        Ok(())
    }
}
pub(super) fn evaluate(model: &Model, bytes: &[u8]) -> Result<bool> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let mut capture = Capture::new(Plan::Root(model));
    let mut path = Vec::new();
    let mut nodes = 0;
    Seed {
        capture: &mut capture,
        path: &mut path,
        nodes: &mut nodes,
        depth: 0,
    }
    .deserialize(&mut deserializer)
    .map_err(|_| Error::Invalid)?;
    deserializer.end().map_err(|_| Error::Invalid)?;
    Ok(capture.complete())
}
