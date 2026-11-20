use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender, sync_channel};
use std::time::{Duration, Instant};

use grep_regex::RegexMatcher;
use ignore::{DirEntry, WalkState};

use super::content::{self, LineMatch, MAX_CONTENT_FILE_BYTES};
use super::request::{SearchRequest, SearchRoot};
use super::{priority, rank, walk};
use crate::workspace::DirectoryEntry;

/// Batches stay far below the 1 MiB frame cap.
pub const MAX_BATCH_HITS: usize = 64;
pub const MAX_BATCH_BYTES: usize = 128 * 1024;
/// A partly filled batch is flushed after this long, so the first hits arrive quickly.
const FLUSH_INTERVAL: Duration = Duration::from_millis(30);
/// Walker → emitter queue. A slow writer blocks the walkers instead of growing memory.
const CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameHit {
    pub root_id: String,
    pub entry: DirectoryEntry,
    pub score: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentHit {
    pub root_id: String,
    pub path: String,
    pub matched: LineMatch,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SearchBatch {
    pub names: Vec<NameHit>,
    pub contents: Vec<ContentHit>,
}

impl SearchBatch {
    fn len(&self) -> usize {
        self.names.len() + self.contents.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Complete,
    Limit,
    Deadline,
    Cancelled,
    /// The emitter could not write (connection gone); treated like a cancellation.
    Disconnected,
}

impl StopReason {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Limit => "limit",
            Self::Deadline => "deadline",
            Self::Cancelled | Self::Disconnected => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchOutcome {
    pub stop: StopReason,
    pub truncated: bool,
    pub files_scanned: u64,
    pub batches: u64,
    pub root_errors: Vec<(String, &'static str)>,
}

enum Found {
    Name(DirectoryEntry, usize),
    Content(String, LineMatch),
}

struct Emitter<'a> {
    emit: &'a mut dyn FnMut(SearchBatch) -> bool,
    batch: SearchBatch,
    bytes: usize,
    started: Option<Instant>,
    sent: usize,
    batches: u64,
    failed: bool,
}

impl Emitter<'_> {
    fn push_content(&mut self, hit: ContentHit) {
        self.bytes += hit.root_id.len() + hit.path.len() + hit.matched.excerpt.len() + 16;
        self.batch.contents.push(hit);
        self.after_push();
    }

    fn push_name(&mut self, hit: NameHit) {
        self.bytes += hit.root_id.len() + hit.entry.path.len() + 32;
        self.batch.names.push(hit);
        self.after_push();
    }

    fn after_push(&mut self) {
        self.sent += 1;
        self.started.get_or_insert_with(Instant::now);
        if self.batch.len() >= MAX_BATCH_HITS || self.bytes >= MAX_BATCH_BYTES {
            self.flush();
        }
    }

    fn flush_if_due(&mut self) {
        if self
            .started
            .is_some_and(|started| started.elapsed() >= FLUSH_INTERVAL)
        {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.batch.len() == 0 {
            return;
        }
        let batch = std::mem::take(&mut self.batch);
        self.bytes = 0;
        self.started = None;
        if self.failed {
            return;
        }
        self.batches += 1;
        if !(self.emit)(batch) {
            self.failed = true;
        }
    }
}

/// Runs one search to completion, cancellation, its deadline or its result limit. Hits stream to
/// `emit` in batches; `emit` returning `false` stops the search. Roots run one after another so
/// earlier roots (the current project first) answer first.
pub fn run_search(
    request: &SearchRequest,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(SearchBatch) -> bool,
) -> SearchOutcome {
    let deadline_at = Instant::now() + request.deadline;
    let name_query = rank::normalize_query(&request.query);
    let search_names = request.mode.names() && !name_query.is_empty();
    let matcher = if request.mode.content() {
        content::build_matcher(&request.query).ok()
    } else {
        None
    };
    let files_scanned = AtomicU64::new(0);
    let mut emitter = Emitter {
        emit,
        batch: SearchBatch::default(),
        bytes: 0,
        started: None,
        sent: 0,
        batches: 0,
        failed: false,
    };
    let mut stop = StopReason::Complete;
    let mut truncated = false;
    let mut root_errors = Vec::new();
    for root in &request.roots {
        if stop != StopReason::Complete {
            break;
        }
        let walker = match walk::build_walker(root, request.threads) {
            Ok(walker) => walker,
            Err(_) => {
                root_errors.push((root.root_id.clone(), "WALK_ERROR"));
                continue;
            }
        };
        let halt = AtomicBool::new(false);
        let (sender, receiver) = sync_channel::<Found>(CHANNEL_CAPACITY);
        let mut ranked = rank::RankedEntries::new(request.max_results_per_root);
        let mut root_contents = 0;
        std::thread::scope(|scope| {
            let visit = RootVisit {
                root,
                halt: &halt,
                cancel,
                files_scanned: &files_scanned,
                name_query: search_names.then_some(&name_query),
                matcher: matcher.as_ref(),
            };
            let background = request.background;
            scope.spawn(move || {
                walker.run(|| {
                    if background {
                        let _accepted = priority::lower_current_thread_priority();
                    }
                    visit.visitor(sender.clone())
                });
                drop(sender);
            });
            loop {
                let wait = deadline_at
                    .saturating_duration_since(Instant::now())
                    .clamp(Duration::from_millis(1), FLUSH_INTERVAL);
                let disconnected = match receiver.recv_timeout(wait) {
                    Ok(Found::Name(entry, score)) => {
                        ranked.insert(entry, score);
                        false
                    }
                    Ok(Found::Content(path, matched)) => {
                        let room = emitter.sent < request.max_results
                            && root_contents < request.max_results_per_root;
                        if room && stop == StopReason::Complete {
                            root_contents += 1;
                            let root_id = root.root_id.clone();
                            emitter.push_content(ContentHit {
                                root_id,
                                path,
                                matched,
                            });
                        } else {
                            truncated = true;
                        }
                        if emitter.sent >= request.max_results {
                            stop = StopReason::Limit;
                        }
                        if root_contents >= request.max_results_per_root && !search_names {
                            // Stopping this root early may leave matches unreported.
                            truncated = true;
                            halt.store(true, Ordering::Relaxed);
                        }
                        false
                    }
                    Err(RecvTimeoutError::Timeout) => false,
                    // Checked below too: a pre-cancelled walk disconnects at once.
                    Err(RecvTimeoutError::Disconnected) => true,
                };
                if stop == StopReason::Complete {
                    if cancel.load(Ordering::Relaxed) {
                        stop = StopReason::Cancelled;
                    } else if emitter.failed {
                        stop = StopReason::Disconnected;
                    } else if Instant::now() >= deadline_at {
                        stop = StopReason::Deadline;
                    }
                }
                if stop != StopReason::Complete {
                    halt.store(true, Ordering::Relaxed);
                }
                emitter.flush_if_due();
                if disconnected {
                    break;
                }
            }
        });
        for (score, entry) in ranked.into_scored_entries() {
            if stop == StopReason::Cancelled || emitter.failed {
                break;
            }
            if emitter.sent >= request.max_results {
                truncated = true;
                break;
            }
            // Scores are small (< 400); saturating is a safe ordering-preserving fallback.
            let score = u32::try_from(score).unwrap_or(u32::MAX);
            let root_id = root.root_id.clone();
            emitter.push_name(NameHit {
                root_id,
                entry,
                score,
            });
        }
        emitter.flush();
    }
    emitter.flush();
    if emitter.failed && stop == StopReason::Complete {
        stop = StopReason::Disconnected;
    }
    SearchOutcome {
        truncated: truncated || matches!(stop, StopReason::Limit | StopReason::Deadline),
        stop,
        files_scanned: files_scanned.load(Ordering::Relaxed),
        batches: emitter.batches,
        root_errors,
    }
}

/// Shared, read-only state each walker thread clones its visitor from.
#[derive(Clone, Copy)]
struct RootVisit<'a> {
    root: &'a SearchRoot,
    halt: &'a AtomicBool,
    cancel: &'a AtomicBool,
    files_scanned: &'a AtomicU64,
    name_query: Option<&'a rank::NameQuery>,
    matcher: Option<&'a RegexMatcher>,
}

impl<'a> RootVisit<'a> {
    fn stopped(&self) -> bool {
        self.halt.load(Ordering::Relaxed) || self.cancel.load(Ordering::Relaxed)
    }

    fn visitor(
        self,
        sender: SyncSender<Found>,
    ) -> Box<dyn FnMut(Result<DirEntry, ignore::Error>) -> WalkState + Send + 'a> {
        let mut searcher = content::build_searcher();
        let matcher = self.matcher.cloned();
        Box::new(move |entry| {
            if self.stopped() {
                return WalkState::Quit;
            }
            // Unreadable entries (permissions, races) are skipped, never fatal.
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let Some(path) = walk::relative_wire_path(self.root, entry.path()) else {
                return WalkState::Continue;
            };
            let Some(kind) = entry.file_type() else {
                return WalkState::Continue;
            };
            if kind.is_symlink() {
                return WalkState::Continue;
            }
            let Ok(metadata) = entry.metadata() else {
                return WalkState::Continue;
            };
            if let Some(query) = self.name_query {
                let candidate = DirectoryEntry {
                    path: path.clone(),
                    is_directory: metadata.is_dir(),
                    is_file: metadata.is_file(),
                    size_bytes: metadata.len(),
                    modified_unix_ms: modified_unix_ms(&metadata),
                };
                if let Some(score) = rank::score_entry(&candidate, query)
                    && sender.send(Found::Name(candidate, score)).is_err()
                {
                    return WalkState::Quit;
                }
            }
            let Some(matcher) = matcher.as_ref() else {
                return WalkState::Continue;
            };
            if !metadata.is_file() || metadata.len() > MAX_CONTENT_FILE_BYTES {
                return WalkState::Continue;
            }
            // Open through the root so a file swapped for a link after the walk is refused.
            let Ok(file) = self.root.workspace.open_file(&path) else {
                return WalkState::Continue;
            };
            self.files_scanned.fetch_add(1, Ordering::Relaxed);
            let keep_going = || !self.stopped();
            let Ok(found) = content::search_file(&mut searcher, matcher, &file, &keep_going) else {
                return WalkState::Continue;
            };
            for matched in found {
                if sender.send(Found::Content(path.clone(), matched)).is_err() {
                    return WalkState::Quit;
                }
            }
            WalkState::Continue
        })
    }
}

fn modified_unix_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
