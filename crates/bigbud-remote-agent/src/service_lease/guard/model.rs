use super::super::{Error, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
pub(super) const MAXIMUM: usize = 16 * 1024 * 1024;
#[derive(Clone)]
pub(super) struct Anchor {
    pub path: PathBuf,
    pub dev: u64,
    pub ino: u64,
    pub uid: u32,
    pub mode: u32,
}
#[derive(Clone, Copy)]
pub(super) enum Origin {
    Configuration,
    Guard,
}
#[derive(Clone)]
pub(super) struct Predicate {
    pub path: Vec<String>,
    pub values: Vec<Value>,
    pub origin: Option<Origin>,
}
#[derive(Clone)]
pub(super) struct Selection {
    pub path: Vec<String>,
    pub key: String,
    pub value: String,
    pub all: Vec<Predicate>,
    pub maximum: usize,
}
#[derive(Clone)]
pub(super) struct Model {
    pub file: PathBuf,
    pub anchors: Vec<Anchor>,
    pub all: Vec<Predicate>,
    pub select: Vec<Selection>,
}
#[derive(Clone)]
pub struct Guard {
    pub(super) model: Arc<Model>,
    raw: Arc<Vec<u8>>,
}
fn member<'a>(value: &'a Value, key: &str) -> Result<&'a Value> {
    value.get(key).ok_or(Error::Invalid)
}
fn fields(value: &Value, names: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or(Error::Invalid)?;
    if object.len() != names.len() || object.keys().any(|key| !names.contains(&key.as_str())) {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn text(value: &Value, max: usize) -> Result<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or(Error::Invalid)
}
fn path(value: &Value) -> Result<PathBuf> {
    let text = text(value, 4096)?;
    let path = PathBuf::from(&text);
    if !path.is_absolute()
        || text.contains("//")
        || text.split('/').any(|v| v == "." || v == "..")
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(Error::Invalid);
    }
    Ok(path)
}
fn decimal(value: &Value) -> Result<u64> {
    let value = text(value, 20)?;
    if (value.starts_with('0') && value.len() > 1) || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::Invalid);
    }
    value.parse().map_err(|_| Error::Invalid)
}
fn list(value: &Value, max: usize) -> Result<&Vec<Value>> {
    value
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= max)
        .ok_or(Error::Invalid)
}
fn keys(value: &Value) -> Result<Vec<String>> {
    list(value, 16)?.iter().map(|v| text(v, 64)).collect()
}
fn predicates(value: &Value, computed: bool) -> Result<Vec<Predicate>> {
    list(value, 32)?
        .iter()
        .map(|item| {
            if let Some(source) = item.get("valueFrom") {
                if !computed {
                    return Err(Error::Invalid);
                }
                fields(item, &["path", "valueFrom"])?;
                let origin = match source.as_str() {
                    Some("configurationSha256") => Origin::Configuration,
                    Some("guardSha256") => Origin::Guard,
                    _ => return Err(Error::Invalid),
                };
                return Ok(Predicate {
                    path: keys(member(item, "path")?)?,
                    values: Vec::new(),
                    origin: Some(origin),
                });
            }
            fields(item, &["path", "values"])?;
            let values = list(member(item, "values")?, 4)?.clone();
            if values.iter().any(|v| match v {
                Value::String(s) => s.len() > 2048,
                Value::Bool(_) => false,
                Value::Number(n) => n.as_u64().is_none_or(|n| n > 9_007_199_254_740_991),
                _ => true,
            }) {
                return Err(Error::Invalid);
            }
            Ok(Predicate {
                path: keys(member(item, "path")?)?,
                values,
                origin: None,
            })
        })
        .collect()
}
impl Guard {
    pub fn parse(raw: &[u8]) -> Result<Self> {
        if raw.is_empty() || raw.len() > 16 * 1024 {
            return Err(Error::Invalid);
        }
        let value: Value = serde_json::from_slice(raw).map_err(|_| Error::Invalid)?;
        fields(&value, &["version", "file", "anchors", "all", "select"])?;
        let version = member(&value, "version")?
            .as_u64()
            .filter(|v| [1, 2].contains(v))
            .ok_or(Error::Invalid)?;
        let file = path(member(&value, "file")?)?;
        let anchors = list(member(&value, "anchors")?, 8)?
            .iter()
            .map(|v| {
                fields(v, &["path", "dev", "ino", "uid", "mode"])?;
                let mode = member(v, "mode")?
                    .as_u64()
                    .filter(|m| [0o700, 0o750, 0o755].contains(m))
                    .ok_or(Error::Invalid)?;
                Ok(Anchor {
                    path: path(member(v, "path")?)?,
                    dev: decimal(member(v, "dev")?)?,
                    ino: decimal(member(v, "ino")?)?,
                    uid: u32::try_from(decimal(member(v, "uid")?)?).map_err(|_| Error::Invalid)?,
                    mode: mode as u32,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut unique = std::collections::HashSet::new();
        if anchors.iter().any(|v| !unique.insert(&v.path))
            || !anchors
                .iter()
                .any(|v| Some(v.path.as_path()) == file.parent())
        {
            return Err(Error::Invalid);
        }
        let all = predicates(member(&value, "all")?, version == 2)?;
        let selected = member(&value, "select")?
            .as_array()
            .filter(|v| v.len() <= 4)
            .ok_or(Error::Invalid)?;
        let select = selected
            .iter()
            .map(|v| {
                let maximum = if let Some(maximum) = v.get("maxRows") {
                    if version != 2 {
                        return Err(Error::Invalid);
                    }
                    fields(v, &["path", "key", "value", "all", "maxRows"])?;
                    maximum
                        .as_u64()
                        .filter(|v| *v >= 1 && *v <= 128)
                        .ok_or(Error::Invalid)? as usize
                } else {
                    fields(v, &["path", "key", "value", "all"])?;
                    32
                };
                Ok(Selection {
                    path: keys(member(v, "path")?)?,
                    key: text(member(v, "key")?, 64)?,
                    value: text(member(v, "value")?, 128)?,
                    all: predicates(member(v, "all")?, version == 2)?,
                    maximum,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if all.len() + select.iter().map(|v| v.all.len()).sum::<usize>() > 32 {
            return Err(Error::Invalid);
        }
        Ok(Self {
            model: Arc::new(Model {
                file,
                anchors,
                all,
                select,
            }),
            raw: Arc::new(raw.to_vec()),
        })
    }
    pub fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.raw.as_slice()).into()
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.raw
    }
    /// Resolve only from the isolated monitor's exact original private body.
    /// Raw bytes/digest are retained unchanged; no self-referential hash is serialized.
    pub(crate) fn bind_configuration(&self, configuration: [u8; 32]) -> Self {
        let mut bound = self.clone();
        let guard = self.digest();
        let model = Arc::make_mut(&mut bound.model);
        for predicate in model
            .all
            .iter_mut()
            .chain(model.select.iter_mut().flat_map(|rule| rule.all.iter_mut()))
        {
            if let Some(origin) = predicate.origin.take() {
                let digest = match origin {
                    Origin::Configuration => configuration,
                    Origin::Guard => guard,
                };
                predicate.values = vec![Value::String(
                    digest.iter().map(|byte| format!("{byte:02x}")).collect(),
                )];
            }
        }
        bound
    }
    pub(crate) fn require_scope(&self, file: &Path, roots: &[&Path]) -> Result<()> {
        if self.model.file != file
            || roots
                .iter()
                .any(|root| !self.model.anchors.iter().any(|a| a.path == *root))
        {
            return Err(Error::Refused);
        }
        super::read::anchors(&self.model)
    }
    pub(super) fn evaluate(&self, bytes: &[u8]) -> Result<bool> {
        if self
            .model
            .all
            .iter()
            .chain(self.model.select.iter().flat_map(|rule| &rule.all))
            .any(|predicate| predicate.origin.is_some())
        {
            return Err(Error::Invalid);
        }
        super::projection::evaluate(&self.model, bytes)
    }
}
