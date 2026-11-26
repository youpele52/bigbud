//! Remote shell guards for the fixed workspace Git recipes.
//!
//! Status needs the real refs, objects and local config for branch and change
//! records, so neither mode substitutes scratch metadata or silently overrides
//! unsupported settings. As with the sibling workspace recipes, this is not a
//! defense against concurrent remote path/metadata replacement.
//!
//! - Fixture: only an ordinary, self-contained repository (physical walk with
//!   no links, nested metadata or special files; a minimal config allowlist).
//! - Production (C06, B): the request's own root (root authority). No
//!   whole-tree walk, because real worktrees contain symlinks and ignored
//!   trees; instead every recipe that names a path walks that path's
//!   components, and the local config allowlist adds keys that cannot launch a
//!   helper or fetch objects for these recipes (remotes, branch tracking, pull
//!   and push defaults, `core.hooksPath`: no recipe runs a hook).

const HEAD: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
[ -r . ] && [ -x . ] || exit 3
command -v git >/dev/null 2>&1 || exit 4
clean_env() {
  exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C HOME=/dev/null XDG_CONFIG_HOME=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
    GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 "$@"
}
gitdir=
if [ ! -L .git ] && [ ! -e .git ]; then
  # Don't discover a bare repo at the root or any repo above it. By keeping
  # discovery (rather than inventing a .git directory), Git can report its
  # own ordinary not-a-repository exit and output.
  [ ! -L HEAD ] && [ ! -e HEAD ] || exit 4
  parent=${PWD%/*}
  case "$parent" in *:*) exit 4 ;; esac
  scope=GIT_CEILING_DIRECTORIES=:${parent:-/}
else
"#;

const FIXTURE_REPO: &str = r#"
  [ ! -L .git ] && [ -d .git ] || exit 4
  gitdir=.git
  scope=GIT_DIR=.git
"#;

// Production also admits a linked worktree: a regular `.git` file whose only
// line is `gitdir: <main>/.git/worktrees/<name>`, with no symlink on that path,
// the back-pointer naming this worktree, `commondir` exactly `../..`, and no
// per-worktree config. No other gitdir redirection is followed. The main
// repository's own metadata is then checked like a plain repository's.
const PRODUCTION_REPO: &str = r#"
  if [ ! -L .git ] && [ -f .git ]; then
    { IFS= read -r line && ! IFS= read -r extra; } < .git || exit 4
    case "$line" in "gitdir: /"*) ;; *) exit 4 ;; esac
    wt=${line#gitdir: }
    case "$wt" in *//*|*/./*|*/../*|*/.|*/..|*"
"*) exit 4 ;; esac
    name=${wt##*/}
    main=${wt%/.git/worktrees/*}
    [ -n "$name" ] && [ "$main/.git/worktrees/$name" = "$wt" ] || exit 4
    [ -d "$wt" ] && [ "$(cd -P "$wt" 2>/dev/null && pwd)" = "$wt" ] || exit 4
    [ ! -L "$main/.git" ] && [ -d "$main/.git" ] || exit 4
    { IFS= read -r back; } < "$wt/gitdir" && [ "$back" = "$PWD/.git" ] || exit 4
    { IFS= read -r common; } < "$wt/commondir" && [ "$common" = "../.." ] || exit 4
    [ ! -e "$wt/config.worktree" ] && [ ! -L "$wt/config.worktree" ] || exit 4
    gitdir=$main/.git
    scope=GIT_DIR=$wt
  else
    [ ! -L .git ] && [ -d .git ] || exit 4
    gitdir=.git
    scope=GIT_DIR=.git
  fi
"#;

// Check the metadata and the worktree with a physical walk. Nested Git
// metadata, links, and special files are outside the fixture's contract.
const FIXTURE_WALK: &str = r#"
  unsafe=$(find . \( \( ! -type d ! -type f \) -o \( ! -path './.git' -name '.[gG][iI][tT]' \) \
    -o -name '.[gG][iI][tT][mM][oO][dD][uU][lL][eE][sS]' \) -print -quit) || exit 4
  [ -z "$unsafe" ] || exit 4
"#;

// Production: submodules can make status launch Git in another repository.
const PRODUCTION_WALK: &str = r#"
  [ ! -e .gitmodules ] && [ ! -L .gitmodules ] || exit 4
  # Hooks may run (commit); a hooks path must stay inside the repository.
  hp=$( (clean_env GIT_DIR=/dev/null git config --file "$gitdir/config" --no-includes --get core.hooksPath) 2>/dev/null ) || hp=
  case "$hp" in /*|"~"*|*..*) exit 4 ;; esac
"#;

const METADATA: &str = r#"
  [ -f "$gitdir/HEAD" ] && [ -d "$gitdir/objects" ] && [ -d "$gitdir/refs" ] || exit 4
  for path in commondir gitdir modules objects/info/alternates objects/info/http-alternates; do
    [ ! -e "$gitdir/$path" ] || exit 4
  done
  # Parse only the local file, without discovery or includes. The sentinel
  # proves that the producer succeeded even on a shell without pipefail.
  # Map embedded LF to an invalid key character before splitting NUL records.
  if [ -e "$gitdir/config" ]; then
    { (clean_env GIT_DIR=/dev/null git config --file "$gitdir/config" --no-includes --null --name-only --list) 2>/dev/null &&
        printf 'OK\000'; } | tr '\n\000' '?\n' | awk '
      /^OK$/ { complete = 1; next }
      /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|quotepath)$/ { next }
      /^user\.(name|email)$/ { next }
      /^remote\.origin\.url$/ { next }
"#;

const PRODUCTION_CONFIG: &str = r#"
      /^core\.hookspath$/ { next }
      /^extensions\.objectformat$/ { next }
      /^remote\.[^?]+\.(url|pushurl|fetch|tagopt|prune)$/ { next }
      /^branch\.[^?]+\.(remote|merge|rebase|pushremote|description)$/ { next }
      /^(pull\.(rebase|ff)|push\.(default|autosetupremote)|init\.defaultbranch|fetch\.prune)$/ { next }
"#;

const TAIL: &str = r#"
      { bad = 1 }
      END { if (!complete || bad) exit 1 }
    ' || exit 4
  fi
fi
"#;

/// The repository guard for one mode.
pub(super) fn guard(production: bool) -> String {
    if production {
        format!("{HEAD}{PRODUCTION_REPO}{PRODUCTION_WALK}{METADATA}{PRODUCTION_CONFIG}{TAIL}")
    } else {
        format!("{HEAD}{FIXTURE_REPO}{FIXTURE_WALK}{METADATA}{TAIL}")
    }
}

// Reject gitlinks (status may launch a subprocess in one), sparse tree
// entries and non-local paths before Git stats anything from the index.
// Git C-quotes LF/tab and other unusual bytes but leaves '/' and '.' literal.
pub(super) const CHECK_INDEX: &str = r#"
if [ -n "$gitdir" ]; then
  { (clean_env "$scope" git -c core.quotePath=true ls-files --stage) 2>/dev/null && printf 'OK\n'; } |
    awk -F '\t' '
      /^OK$/ { complete = 1; next }
      NF != 2 || $1 !~ /^(100644|100755|120000) [0-9a-f]+ [0-3]$/ { bad = 1; next }
      {
        path = $2
        if (path ~ /^"/) path = substr(path, 2, length(path) - 2)
        if (path ~ /(^|\/)(\.{1,2})?(\/|$)/) bad = 1
      }
      END { if (!complete || bad) exit 1 }
    ' || exit 4
fi
"#;

/// Production: a recipe that reads a named file outside Git's index (the
/// untracked numstat and diff) must not follow a symlink on any component,
/// and the final component must be a regular file. The recipe first runs
/// `set --` with the quoted repository-relative operands.
pub(super) const CHECK_REGULAR_PATHS: &str = r#"
for rel in "$@"; do
  cur=.
  rest=$rel
  while :; do
    part=${rest%%/*}
    cur=$cur/$part
    [ ! -L "$cur" ] || exit 3
    [ "$part" = "$rest" ] && break
    rest=${rest#*/}
  done
  [ -f "$cur" ] || exit 3
done
"#;
