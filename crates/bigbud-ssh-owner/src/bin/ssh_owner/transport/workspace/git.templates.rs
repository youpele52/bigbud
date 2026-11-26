//! Branch, checkout, commit, worktree, range, stash, init and remote recipes
//! (actions 26-74).
//!
//! Each action is one fixed argv template. A template word is either literal
//! or a typed slot; operands arrive in order and are validated per slot type
//! before anything is sent. No operand can become an option: refs never start
//! with `-`, paths are repository-relative data, messages follow `-m`, and a
//! worktree path must be an absolute, normalized sibling of the workspace root.

use super::ErrorCode;
use super::quote;

#[path = "git.templates.operands.rs"]
mod operands;
pub(super) use operands::is_ref;
use operands::{
    MAX_MESSAGE_BYTES, MAX_PATHS, is_commit, is_relative_path, is_remote_url, is_sibling_worktree,
    is_stash_ref,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Slot {
    /// A branch or remote-tracking name (`main`, `origin/feature-1`).
    Ref,
    /// `refs/heads/<ref>` or `refs/remotes/<ref>` as one word.
    Prefixed(&'static str),
    /// `<ref>..HEAD` as one word.
    RangeToHead,
    /// A commit message (subject or body).
    Message,
    /// One or more repository-relative paths (the rest of the operands).
    Paths,
    /// A linked worktree directory next to the workspace root.
    Worktree,
    /// A lowercase hex commit (4-64).
    Commit,
    /// A ref name or a lowercase hex commit (a start point).
    RefOrCommit,
    /// `stash@{N}`.
    StashRef,
    /// A remote name: a ref name without `/`.
    RemoteName,
    /// A remote URL or path for `remote add` (no transport helpers).
    RemoteUrl,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Word {
    Lit(&'static str),
    Slot(Slot),
}

use Slot::{
    Commit, Message, Paths, Prefixed, RangeToHead, Ref, RefOrCommit, RemoteName, RemoteUrl,
    StashRef, Worktree,
};
use Word::{Lit, Slot as S};

pub(super) struct Template {
    pub(super) words: &'static [Word],
    /// Output cap with a flagged cut (like the commit file diff), if any.
    pub(super) cap: Option<u32>,
    pub(super) mutation: bool,
    /// Commits run the repository's hooks with the session PATH and HOME.
    pub(super) commit: bool,
}

const fn t(words: &'static [Word], mutation: bool) -> Template {
    Template {
        words,
        cap: None,
        mutation,
        commit: false,
    }
}

const fn capped(words: &'static [Word], cap: u32) -> Template {
    Template {
        words,
        cap: Some(cap),
        mutation: false,
        commit: false,
    }
}

const fn commit(words: &'static [Word]) -> Template {
    Template {
        words,
        cap: None,
        mutation: true,
        commit: true,
    }
}

pub(super) const FIRST: i32 = 26;

/// Actions 26-74, in enum order.
pub(super) const TEMPLATES: [Template; 49] = [
    t(
        &[
            Lit("show-ref"),
            Lit("--verify"),
            Lit("--quiet"),
            S(Prefixed("refs/heads/")),
        ],
        false,
    ),
    t(
        &[
            Lit("show-ref"),
            Lit("--verify"),
            Lit("--quiet"),
            S(Prefixed("refs/remotes/")),
        ],
        false,
    ),
    t(
        &[
            Lit("for-each-ref"),
            Lit("--format=%(refname:short)\t%(upstream:short)"),
            Lit("refs/heads"),
        ],
        false,
    ),
    t(&[Lit("branch"), Lit("--show-current")], false),
    t(
        &[
            Lit("symbolic-ref"),
            Lit("--quiet"),
            Lit("--short"),
            Lit("refs/remotes/origin/HEAD"),
        ],
        false,
    ),
    t(&[Lit("worktree"), Lit("list"), Lit("--porcelain")], false),
    t(
        &[Lit("branch"), Lit("--no-color"), Lit("--no-column")],
        false,
    ),
    t(
        &[
            Lit("branch"),
            Lit("--no-color"),
            Lit("--no-column"),
            Lit("--remotes"),
        ],
        false,
    ),
    t(&[Lit("remote")], false),
    t(&[Lit("remote"), Lit("-v")], false),
    t(
        &[
            Lit("for-each-ref"),
            Lit("--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)"),
            Lit("refs/heads"),
            Lit("refs/remotes"),
        ],
        false,
    ),
    capped(&[Lit("log"), Lit("--oneline"), S(RangeToHead)], 19_000),
    capped(
        &[
            Lit("diff"),
            Lit("--no-ext-diff"),
            Lit("--no-textconv"),
            Lit("--stat"),
            S(RangeToHead),
        ],
        19_000,
    ),
    capped(
        &[
            Lit("diff"),
            Lit("--no-ext-diff"),
            Lit("--no-textconv"),
            Lit("--patch"),
            Lit("--minimal"),
            S(RangeToHead),
        ],
        59_000,
    ),
    t(&[Lit("diff"), Lit("--cached"), Lit("--name-status")], false),
    capped(
        &[
            Lit("diff"),
            Lit("--no-ext-diff"),
            Lit("--no-textconv"),
            Lit("--cached"),
            Lit("--patch"),
            Lit("--minimal"),
        ],
        49_000,
    ),
    t(&[Lit("rev-parse"), Lit("HEAD")], false),
    t(&[Lit("reset")], true),
    t(&[Lit("add"), Lit("-A")], true),
    t(&[Lit("add"), Lit("-A"), Lit("--"), S(Paths)], true),
    commit(&[Lit("commit"), Lit("-m"), S(Message)]),
    commit(&[Lit("commit"), Lit("-m"), S(Message), Lit("-m"), S(Message)]),
    t(&[Lit("checkout"), S(Ref)], true),
    t(&[Lit("checkout"), Lit("--track"), S(Ref)], true),
    t(&[Lit("branch"), S(Ref)], true),
    t(&[Lit("branch"), Lit("-m"), Lit("--"), S(Ref)], true),
    t(&[Lit("branch"), Lit("-m"), Lit("--"), S(Ref), S(Ref)], true),
    t(&[Lit("branch"), Lit("-d"), Lit("--"), S(Ref)], true),
    t(
        &[Lit("branch"), Lit("--set-upstream-to"), S(Ref), S(Ref)],
        true,
    ),
    t(&[Lit("worktree"), Lit("add"), S(Worktree), S(Ref)], true),
    t(
        &[
            Lit("worktree"),
            Lit("add"),
            Lit("-b"),
            S(Ref),
            S(Worktree),
            S(Ref),
        ],
        true,
    ),
    t(&[Lit("worktree"), Lit("remove"), S(Worktree)], true),
    t(
        &[Lit("worktree"), Lit("remove"), Lit("--force"), S(Worktree)],
        true,
    ),
    // 59: the branch list's default-branch read.
    t(
        &[Lit("symbolic-ref"), Lit("refs/remotes/origin/HEAD")],
        false,
    ),
    // 60-74: force delete of the named branch, new branches, stash, init,
    // remote add and the worktree-creation recipe at a fixed commit.
    t(&[Lit("branch"), Lit("-D"), Lit("--"), S(Ref)], true),
    t(&[Lit("checkout"), Lit("-b"), S(Ref)], true),
    t(&[Lit("checkout"), Lit("-b"), S(Ref), S(RefOrCommit)], true),
    t(&[Lit("stash"), Lit("push")], true),
    t(&[Lit("stash"), Lit("push"), Lit("-m"), S(Message)], true),
    t(&[Lit("stash"), Lit("pop")], true),
    t(&[Lit("stash"), Lit("pop"), S(StashRef)], true),
    t(&[Lit("stash"), Lit("apply")], true),
    t(&[Lit("stash"), Lit("apply"), S(StashRef)], true),
    t(&[Lit("stash"), Lit("list")], false),
    t(&[Lit("stash"), Lit("drop")], true),
    t(&[Lit("stash"), Lit("drop"), S(StashRef)], true),
    t(&[Lit("init")], true),
    t(
        &[Lit("remote"), Lit("add"), S(RemoteName), S(RemoteUrl)],
        true,
    ),
    t(
        &[
            Lit("worktree"),
            Lit("add"),
            Lit("-b"),
            S(Ref),
            Lit("--"),
            S(Worktree),
            S(Commit),
        ],
        true,
    ),
];

pub(super) fn template(action: i32) -> Option<&'static Template> {
    usize::try_from(action - FIRST)
        .ok()
        .and_then(|index| TEMPLATES.get(index))
}

/// The fixed `git` arguments, or a typed refusal for a bad operand.
pub(super) fn args(
    template: &Template,
    operands: &[String],
    root: &str,
) -> Result<String, ErrorCode> {
    let invalid = ErrorCode::InvalidOperands;
    let mut rest = operands.iter();
    let mut words = Vec::new();
    for word in template.words {
        match *word {
            Lit(literal) => words.push(quote(literal)),
            S(Paths) => {
                let paths: Vec<&String> = rest.by_ref().collect();
                if paths.is_empty() || paths.len() > MAX_PATHS {
                    return Err(invalid);
                }
                for path in paths {
                    if !is_relative_path(path) {
                        return Err(invalid);
                    }
                    words.push(quote(path));
                }
            }
            S(slot) => {
                let value = rest.next().ok_or(invalid)?;
                let ok = match slot {
                    Ref => is_ref(value),
                    Prefixed(prefix) => value.strip_prefix(prefix).is_some_and(is_ref),
                    RangeToHead => value.strip_suffix("..HEAD").is_some_and(is_ref),
                    Message => {
                        !value.trim().is_empty()
                            && value.len() <= MAX_MESSAGE_BYTES
                            && !value.contains('\0')
                    }
                    Worktree => is_sibling_worktree(value, root),
                    Commit => is_commit(value),
                    RefOrCommit => is_ref(value) || is_commit(value),
                    StashRef => is_stash_ref(value),
                    RemoteName => is_ref(value) && !value.contains('/'),
                    RemoteUrl => is_remote_url(value),
                    Paths => false,
                };
                if !ok {
                    return Err(invalid);
                }
                words.push(quote(value));
            }
        }
    }
    if rest.next().is_some() {
        return Err(invalid);
    }
    Ok(words.join(" "))
}

/// Commit identity and hooks: the repository-local identity wins; otherwise
/// only `user.name`/`user.email` are read (no includes) from the user's global
/// file. Hooks run with the session's PATH and HOME, as any commit would.
pub(super) fn commit_command(args: &str) -> String {
    format!(
        r#"
ident() {{
  for f in "$HOME/.gitconfig" "${{XDG_CONFIG_HOME:-$HOME/.config}}/git/config"; do
    [ -f "$f" ] || continue
    v=$(clean_env GIT_DIR=/dev/null git config --file "$f" --no-includes --get "$1" 2>/dev/null) || continue
    [ -n "$v" ] && {{ printf '%s' "$v"; return 0; }}
  done
  return 0
}}
set -- "$scope" "PATH=$PATH" "HOME=$HOME"
if [ -z "$(clean_env GIT_DIR=/dev/null git config --file "$gitdir/config" --no-includes --get user.name 2>/dev/null)" ]; then
  name=$(ident user.name)
  [ -z "$name" ] || set -- "$@" "GIT_AUTHOR_NAME=$name" "GIT_COMMITTER_NAME=$name"
fi
if [ -z "$(clean_env GIT_DIR=/dev/null git config --file "$gitdir/config" --no-includes --get user.email 2>/dev/null)" ]; then
  email=$(ident user.email)
  [ -z "$email" ] || set -- "$@" "GIT_AUTHOR_EMAIL=$email" "GIT_COMMITTER_EMAIL=$email"
fi
clean_env "$@" git {args}"#
    )
}
