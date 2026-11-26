//! Per-PTY activity facts and the three deliberately separate busy definitions (plan §8.5).
//!
//! | Use               | Busy when                                                         |
//! | ----------------- | ----------------------------------------------------------------- |
//! | Idle/warning      | foreground program, or owner hint busy/unknown (output is covered |
//! |                   | by `quiet_since`)                                                 |
//! | Memory pressure   | the idle rule, or output in the last 10 minutes                   |
//! | Sidebar colour    | foreground program, owner hint busy, or output in the last 60 s   |

/// Output this soon after a host-applied resize is a redraw, not activity.
pub const RESIZE_REDRAW_GRACE_MS: u64 = 1_000;
pub const PRESSURE_OUTPUT_WINDOW_MS: u64 = 10 * 60 * 1_000;
pub const SIDEBAR_OUTPUT_WINDOW_MS: u64 = 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewState {
    /// Some client shows the terminal right now. A visible PTY is never idle.
    Visible,
    Hidden,
}

/// Direct SSH owner's report about the remote foreground program. `Unknown` counts as busy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerHint {
    Busy,
    Idle,
    Unknown,
}

/// Pending idle warning for one quiet period.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct IdleWarning {
    pub(super) period: u64,
    pub(super) closes_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityTracker {
    pub(super) managed: bool,
    pub(super) created_at: u64,
    pub(super) last_input: Option<u64>,
    pub(super) last_output: Option<u64>,
    pub(super) resize_applied_at: Option<u64>,
    pub(super) view: ViewState,
    pub(super) last_focus: Option<u64>,
    pub(super) last_focus_end: Option<u64>,
    pub(super) keep_open_at: Option<u64>,
    pub(super) foreground_program: bool,
    pub(super) owner_hint: Option<OwnerHint>,
    /// When the idle-busy fact last changed; a program starting or ending starts a new period.
    pub(super) busy_changed_at: Option<u64>,
    pub(super) warning: Option<IdleWarning>,
}

impl ActivityTracker {
    /// A new PTY starts hidden; the view report makes it visible.
    pub fn new(lifecycle_managed: bool, created_at: u64) -> Self {
        Self {
            managed: lifecycle_managed,
            created_at,
            last_input: None,
            last_output: None,
            resize_applied_at: None,
            view: ViewState::Hidden,
            last_focus: None,
            last_focus_end: None,
            keep_open_at: None,
            foreground_program: false,
            owner_hint: None,
            busy_changed_at: None,
            warning: None,
        }
    }

    pub fn lifecycle_managed(&self) -> bool {
        self.managed
    }

    /// Accepted client input. Never call this for query-responder replies.
    pub fn record_input(&mut self, now: u64) {
        self.last_input = Some(now);
    }

    /// Replies the host's query responder writes to the PTY (plan §8.9). They are not client
    /// input, so they move no activity fact; this exists to make that rule explicit at call
    /// sites.
    pub fn record_responder_reply(&mut self, _now: u64) {}

    /// PTY output, ignoring the redraw that follows a resize the host applied.
    pub fn record_output(&mut self, now: u64) {
        let redraw = self
            .resize_applied_at
            .is_some_and(|at| now >= at && now - at < RESIZE_REDRAW_GRACE_MS);
        if !redraw {
            self.last_output = Some(now);
        }
    }

    pub fn record_resize_applied(&mut self, now: u64) {
        self.resize_applied_at = Some(now);
    }

    /// The union view state across callers. Hiding ends the focus period.
    pub fn set_view_state(&mut self, view: ViewState, now: u64) {
        match (self.view, view) {
            (ViewState::Visible, ViewState::Hidden) => self.last_focus_end = Some(now),
            (ViewState::Hidden, ViewState::Visible) => self.last_focus = Some(now),
            _ => {}
        }
        self.view = view;
    }

    pub fn record_focus(&mut self, now: u64) {
        self.last_focus = Some(now);
        if self.view == ViewState::Hidden {
            self.last_focus_end = Some(now);
        }
    }

    /// The user chose "Keep open": a fresh quiet period starts now.
    pub fn keep_open(&mut self, now: u64) {
        self.keep_open_at = Some(now);
    }

    pub fn set_foreground_program(&mut self, foreground: bool, now: u64) {
        let before = self.idle_busy();
        self.foreground_program = foreground;
        self.note_busy_change(before, now);
    }

    pub fn set_owner_hint(&mut self, hint: Option<OwnerHint>, now: u64) {
        let before = self.idle_busy();
        self.owner_hint = hint;
        self.note_busy_change(before, now);
    }

    fn note_busy_change(&mut self, before: bool, now: u64) {
        if before != self.idle_busy() {
            self.busy_changed_at = Some(now);
        }
    }

    pub fn view_state(&self) -> ViewState {
        self.view
    }

    pub fn foreground_program(&self) -> bool {
        self.foreground_program
    }

    pub fn last_input(&self) -> Option<u64> {
        self.last_input
    }

    pub fn last_output(&self) -> Option<u64> {
        self.last_output
    }

    /// Busy for the idle/warning state machine.
    pub fn idle_busy(&self) -> bool {
        self.foreground_program
            || matches!(self.owner_hint, Some(OwnerHint::Busy | OwnerHint::Unknown))
    }

    pub fn recent_output(&self, now: u64, window_ms: u64) -> bool {
        self.last_output
            .is_some_and(|at| now.saturating_sub(at) < window_ms)
    }

    /// Busy for memory-pressure candidacy (§8.6).
    pub fn pressure_busy(&self, now: u64) -> bool {
        self.idle_busy() || self.recent_output(now, PRESSURE_OUTPUT_WINDOW_MS)
    }

    /// Busy for the sidebar colour (§11.2). An `Unknown` hint shows muted, not blue.
    pub fn sidebar_busy(&self, now: u64) -> bool {
        self.foreground_program
            || self.owner_hint == Some(OwnerHint::Busy)
            || self.recent_output(now, SIDEBAR_OUTPUT_WINDOW_MS)
    }

    /// `max(last_input, last_output, last_focus_end, keep_open_at, created_at)`, plus the last
    /// idle-busy change so a program that just ended starts a fresh period.
    pub fn quiet_since(&self) -> u64 {
        [
            self.last_input,
            self.last_output,
            self.last_focus_end,
            self.keep_open_at,
            self.busy_changed_at,
        ]
        .into_iter()
        .flatten()
        .fold(self.created_at, u64::max)
    }

    /// LRU key for pressure and limit eviction: `max(last_input, last_focus)`.
    pub fn last_used(&self) -> u64 {
        [self.last_input, self.last_focus]
            .into_iter()
            .flatten()
            .fold(self.created_at, u64::max)
    }

    /// Managed, hidden and not idle-busy: the quiet clock is running.
    pub fn idle_eligible(&self) -> bool {
        self.managed && self.view == ViewState::Hidden && !self.idle_busy()
    }

    /// The pending warning's close deadline, if any.
    pub fn warning_closes_at(&self) -> Option<u64> {
        self.warning.map(|warning| warning.closes_at)
    }
}
