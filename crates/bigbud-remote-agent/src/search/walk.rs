use ignore::WalkBuilder;
use ignore::overrides::{Override, OverrideBuilder};

use super::request::SearchRoot;

/// Always skipped, whatever the ignore files say: the union of the former agent and server lists.
pub const ALWAYS_SKIPPED_DIRECTORIES: [&str; 11] = [
    ".git",
    "node_modules",
    "target",
    ".bigbud",
    ".next",
    ".turbo",
    ".convex",
    "dist",
    "build",
    "out",
    ".cache",
];

/// Skip globs for the walker's override matcher. Override globs are whitelists by default; a
/// leading `!` turns each one into an ignore rule.
fn skip_overrides(root: &SearchRoot) -> Result<Override, ignore::Error> {
    let mut builder = OverrideBuilder::new(&root.start);
    for directory in ALWAYS_SKIPPED_DIRECTORIES {
        builder.add(&format!("!{directory}/"))?;
    }
    builder.build()
}

/// Walker for one root, matching `rg --hidden` semantics: `.gitignore`, `.ignore` and the global
/// excludes file apply; hidden files are included; links and junctions are never followed.
pub fn build_walker(
    root: &SearchRoot,
    threads: usize,
) -> Result<ignore::WalkParallel, ignore::Error> {
    let mut builder = WalkBuilder::new(&root.start);
    builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .same_file_system(false)
        .threads(threads)
        .overrides(skip_overrides(root)?);
    Ok(builder.build_parallel())
}

/// `/`-separated path relative to the workspace root, or `None` for the root itself and for
/// names that are not valid UTF-8 (the wire path is UTF-8).
pub fn relative_wire_path(root: &SearchRoot, path: &std::path::Path) -> Option<String> {
    let relative = path.strip_prefix(root.workspace.root()).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(name) => parts.push(name.to_str()?),
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}
