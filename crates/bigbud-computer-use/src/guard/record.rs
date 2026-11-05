use crate::worker::ExecutionRoot;

pub const MAX_ROOTS: usize = 8;
pub const MAX_RECORD_BYTES: usize = 16 * 1024;

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

/// Namespaced decimal revision: digits only, no leading zero, fits u64.
pub fn parse_revision(text: &str) -> Option<u64> {
    let canonical = !text.is_empty()
        && text.len() <= 20
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    canonical.then(|| text.parse().ok()).flatten()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyBinding {
    pub authority: String,
    pub controller_installation: String,
    pub profile_generation: String,
    pub revision: String,
    pub digest: String,
    pub migration_binding: String,
}
impl PolicyBinding {
    pub fn valid(&self) -> bool {
        valid_id(&self.authority)
            && valid_id(&self.controller_installation)
            && valid_id(&self.profile_generation)
            && valid_id(&self.migration_binding)
            && parse_revision(&self.revision).is_some()
            && self.digest.len() == 64
            && self
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeState {
    Required,
    PresentedUnconfirmed,
    Acked,
}
impl NoticeState {
    pub(crate) fn text(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::PresentedUnconfirmed => "presented_unconfirmed",
            Self::Acked => "acked",
        }
    }
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "required" => Some(Self::Required),
            "presented_unconfirmed" => Some(Self::PresentedUnconfirmed),
            "acked" => Some(Self::Acked),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeNotice {
    pub episode: String,
    pub notice: String,
    pub state: NoticeState,
}

/// Safety metadata only: no application inventory, policy values, MCP or content.
/// Epochs are durable; monotonic timestamps are deliberately not persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafetyRecord {
    pub pause_epoch: u64,
    pub latched: bool,
    pub reason: String,
    pub armed: bool,
    pub input_uncertain: bool,
    pub binding: Option<PolicyBinding>,
    pub notice: Option<EpisodeNotice>,
    pub roots: Vec<ExecutionRoot>,
}
impl SafetyRecord {
    /// Missing state is not a recognized legacy migration. First human binding
    /// and Resume are required; no default grant-all or silent readiness.
    pub fn initial() -> Self {
        Self {
            pause_epoch: 0,
            latched: true,
            reason: "initial".into(),
            armed: false,
            input_uncertain: false,
            binding: None,
            notice: None,
            roots: vec![],
        }
    }
    pub fn valid(&self) -> bool {
        valid_id(&self.reason)
            && self.roots.len() <= MAX_ROOTS
            && self.binding.as_ref().is_none_or(PolicyBinding::valid)
            && self
                .notice
                .as_ref()
                .is_none_or(|notice| valid_id(&notice.episode) && valid_id(&notice.notice))
            && self.roots.iter().all(ExecutionRoot::valid)
            && self.roots.iter().enumerate().all(|(index, root)| {
                self.roots
                    .iter()
                    .skip(index + 1)
                    .all(|other| other.pid != root.pid)
            })
            && (self.armed || self.roots.is_empty())
            && (!self.input_uncertain || self.latched || self.armed)
    }
}
