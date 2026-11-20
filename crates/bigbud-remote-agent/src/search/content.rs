use std::io;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};

/// Files larger than this are skipped (the same cap as text previews).
pub const MAX_CONTENT_FILE_BYTES: u64 = crate::workspace::MAX_TEXT_PREVIEW_BYTES as u64;
/// At most this many matching lines are reported per file.
pub const MAX_MATCHES_PER_FILE: usize = 5;
/// Excerpts are truncated to this many characters.
pub const MAX_EXCERPT_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineMatch {
    pub line: u32,
    /// 1-based byte column of the first match on the line (same unit as the legacy search).
    pub column: u32,
    pub excerpt: String,
}

/// Literal, always case-insensitive matcher (`rg --fixed-strings --ignore-case`). Folding is
/// Unicode simple case folding, so `Youpele` finds `youpele` and `ÉTÉ` finds `été`.
pub fn build_matcher(query: &str) -> Result<RegexMatcher, grep_regex::Error> {
    RegexMatcherBuilder::new()
        .case_insensitive(true)
        .fixed_strings(true)
        .build(query)
}

/// Read-based searcher (mmap stays off) that stops at the first NUL byte, so binary files cost
/// one buffer read.
pub fn build_searcher() -> Searcher {
    SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build()
}

/// Searches one already-opened file. `keep_going` is polled per match so cancellation and the
/// deadline stop a large file early.
pub fn search_file(
    searcher: &mut Searcher,
    matcher: &RegexMatcher,
    file: &std::fs::File,
    keep_going: &dyn Fn() -> bool,
) -> io::Result<Vec<LineMatch>> {
    let mut matches = Vec::new();
    searcher.search_file(
        matcher,
        file,
        Lossy(|line_number, line| {
            if !keep_going() {
                return Ok(false);
            }
            let text = line.trim_end_matches(['\n', '\r']);
            let column = matcher
                .find(text.as_bytes())
                .map_err(io::Error::other)?
                .map_or(1, |found| found.start() + 1);
            // Saturating keeps absurdly long files reportable instead of failing the search.
            matches.push(LineMatch {
                line: u32::try_from(line_number).unwrap_or(u32::MAX),
                column: u32::try_from(column).unwrap_or(u32::MAX),
                excerpt: text.chars().take(MAX_EXCERPT_CHARS).collect(),
            });
            Ok(matches.len() < MAX_MATCHES_PER_FILE)
        }),
    )?;
    Ok(matches)
}
