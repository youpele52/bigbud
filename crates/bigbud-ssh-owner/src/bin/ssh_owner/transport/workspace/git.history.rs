//! History panel recipes (actions 20-25): commit list, unpushed marks, one
//! commit's summary and changed files, and one file's patch with a byte cap.
//! Every operand is validated data; nothing here is a caller-chosen argument.

use super::ErrorCode;
use super::quote;
use super::recipe::Recipe;

pub(super) const LOG_FORMAT: &str = "--format=%H%x00%h%x00%an%x00%aE%x00%aI%x00%s%x00%D%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f,unfold=true)%x1e";
pub(super) const SUMMARY_FORMAT: &str = "--format=%H%x00%h%x00%an%x00%aE%x00%aI%x00%s%x00%D%x00%B%x00%P%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f,unfold=true)";
pub(super) const MAX_LOG_LIMIT: u32 = 101;
pub(super) const MAX_LOG_SKIP: u32 = 1_000_000;
pub(super) const MAX_FILE_DIFF_BYTES: u32 = 1_000_000;

/// The history operands of one request.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct History<'a> {
    pub(super) revision: &'a str,
    pub(super) limit: u32,
    pub(super) skip: u32,
    pub(super) max_output_bytes: u32,
}

fn is_commit(revision: &str) -> bool {
    (4..=64).contains(&revision.len())
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// An upstream ref as `rev-parse --abbrev-ref @{upstream}` prints it.
fn is_ref_name(revision: &str) -> bool {
    !revision.is_empty()
        && revision.len() <= 255
        && !revision.starts_with(['-', '/', '.'])
        && !revision.ends_with(['/', '.'])
        && !revision.ends_with(".lock")
        && !revision.contains("..")
        && !revision.contains("//")
        && !revision.contains("@{")
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
}

/// Only history recipes take history operands, each exactly its own.
pub(super) fn validate(recipe: Recipe, history: History<'_>) -> Result<(), ErrorCode> {
    let ok = match recipe {
        Recipe::CommitLog => {
            history.revision.is_empty()
                && (1..=MAX_LOG_LIMIT).contains(&history.limit)
                && history.skip <= MAX_LOG_SKIP
                && history.max_output_bytes == 0
        }
        Recipe::UnpushedShas => {
            is_ref_name(history.revision)
                && history.limit == 0
                && history.skip == 0
                && history.max_output_bytes == 0
        }
        Recipe::CommitSummary | Recipe::CommitNumstat => {
            is_commit(history.revision)
                && history.limit == 0
                && history.skip == 0
                && history.max_output_bytes == 0
        }
        Recipe::CommitFileDiff => {
            is_commit(history.revision)
                && history.limit == 0
                && history.skip == 0
                && (1..=MAX_FILE_DIFF_BYTES).contains(&history.max_output_bytes)
        }
        _ => {
            history.revision.is_empty()
                && history.limit == 0
                && history.skip == 0
                && history.max_output_bytes == 0
        }
    };
    if ok {
        Ok(())
    } else {
        Err(ErrorCode::InvalidOperands)
    }
}

/// The fixed `git` arguments for a history recipe (after `git`).
pub(super) fn args(recipe: Recipe, history: History<'_>, paths: &[String]) -> Option<String> {
    let revision = quote(history.revision);
    Some(match recipe {
        Recipe::CommitLog => {
            let skip = if history.skip > 0 {
                format!(" --skip={}", history.skip)
            } else {
                String::new()
            };
            format!(
                "log --max-count={}{skip} {}",
                history.limit,
                quote(LOG_FORMAT)
            )
        }
        Recipe::UpstreamRef => "rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'".into(),
        Recipe::UnpushedShas => {
            format!(
                "rev-list {} --",
                quote(&format!("{}..HEAD", history.revision))
            )
        }
        Recipe::CommitSummary => format!("show -s {} {revision}", quote(SUMMARY_FORMAT)),
        Recipe::CommitNumstat => {
            format!("show --format= --numstat -z --find-renames --find-copies {revision} --")
        }
        Recipe::CommitFileDiff => {
            let pathspecs = paths
                .iter()
                .map(|path| quote(&format!(":(top,literal){path}")))
                .collect::<Vec<_>>()
                .join(" ");
            format!(
                "show --format= --find-renames --find-copies --no-ext-diff --no-textconv {revision} -- {pathspecs}"
            )
        }
        _ => return None,
    })
}

/// Cut stdout at `cap + 1` bytes on the target, keeping Git's own exit status
/// unless the cut happened (then the result is flagged truncated by the owner).
pub(super) fn capped(command: &str, cap: u32) -> String {
    format!(
        "exec 4>&1\nstatus=$( {{ {{ ( {command} ) 3>&- 4>&-; printf '%s' \"$?\" >&3; }} | head -c {} >&4; }} 3>&1 )\nexit \"${{status:-1}}\"",
        u64::from(cap) + 1
    )
}
