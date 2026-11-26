//! Operand validators for the fixed Git argv templates (`git.templates.rs`):
//! refs, commits, stash refs, remote URLs, repository-relative paths and
//! sibling worktree directories. Each refuses anything that could become an
//! option or escape the workspace.

pub(super) const MAX_MESSAGE_BYTES: usize = 65_536;
pub(super) const MAX_PATHS: usize = 200;

pub(super) fn is_commit(value: &str) -> bool {
    (4..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn is_stash_ref(value: &str) -> bool {
    value
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'))
        .is_some_and(|index| {
            (1..=4).contains(&index.len()) && index.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// `remote add` only records the URL; fetch and push route it later (U14/U15).
/// Transport helpers (`ext::`, `<helper>::`), options and control bytes are refused.
pub(super) fn is_remote_url(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 2048
        && !value.starts_with('-')
        && !value.contains("::")
        && !value.bytes().any(|byte| byte.is_ascii_control())
        && (value.starts_with("https://")
            || value.starts_with("http://")
            || value.starts_with("ssh://")
            || value.starts_with("file://")
            || value.starts_with('/')
            || value.split_once(':').is_some_and(|(host, _)| {
                !host.is_empty() && !host.contains('/') && !host.contains("://")
            }))
}

/// Git's ref-name rules for the names the product passes.
pub(in super::super) fn is_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.starts_with(['-', '/', '.'])
        && !value.ends_with(['/', '.'])
        && !value.ends_with(".lock")
        && !value.contains("..")
        && !value.contains("//")
        && !value.contains("/.")
        && !value.contains("@{")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
}

pub(super) fn is_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains(['\0', '\\'])
        && !value.starts_with(['/', '-'])
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// An absolute, normalized directory whose parent is the workspace root's parent.
pub(super) fn is_sibling_worktree(value: &str, root: &str) -> bool {
    let parent = |path: &str| path.rsplit_once('/').map(|(head, _)| head.to_owned());
    value.starts_with('/')
        && value.len() <= 1024
        && !value.contains(['\0', '\\', '\n'])
        && value
            .strip_prefix('/')
            .unwrap_or(value)
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && value != root
        && parent(value).is_some_and(|head| Some(head) == parent(root))
}
