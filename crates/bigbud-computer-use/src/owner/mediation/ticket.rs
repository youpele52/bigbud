//! What an admitted operation may forward: the exact helper sequence for its
//! public action (plan M2 "Primitive plan and delivery mapping"), mirrored by
//! the TypeScript plan and pinned together by `plan.v1.golden.json`.
use super::profile::{MAX_ACCESSIBILITY_DEPTH, SCROLL_CHUNK_MAX, Tool};

pub const ACCESSIBILITY_DEFAULT_DEPTH: i64 = 25;
/// Normalized public scroll maximum (plan M3 scroll normalization).
pub const SCROLL_TOTAL_MAX: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Background,
    Foreground,
}

impl Delivery {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Background => "background",
            Self::Foreground => "foreground",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

impl ScrollDirection {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admitted {
    /// Qualified window capture (registers an action capture).
    Capture,
    /// Capture plus the bounded element tree.
    PageInfo,
    /// Targeted accessibility read without pixels.
    Tree {
        depth: i64,
    },
    Click,
    Drag,
    Type,
    Key {
        chord: bool,
    },
    Scroll {
        direction: ScrollDirection,
        total: i64,
        at_point: bool,
    },
    Focus,
    ListApps,
    /// Also unscoped accessibility, which is filtered discovery.
    ListWindows,
    CheckPermissions,
    Doctor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ticket {
    pub admitted: Admitted,
    /// Resolved delivery; meaningful for input actions only.
    pub delivery: Delivery,
    pub capture_after: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Expect {
    /// Non-restoring foreground prelude (`bring_to_front`).
    Front,
    Read {
        screenshot: bool,
        depth: Option<i64>,
    },
    Input(Tool),
    ScrollChunk,
    Plain(Tool),
}

impl Expect {
    pub(super) fn tool(self) -> Tool {
        match self {
            Self::Front => Tool::BringToFront,
            Self::Read { .. } => Tool::GetWindowState,
            Self::Input(tool) | Self::Plain(tool) => tool,
            Self::ScrollChunk => Tool::Scroll,
        }
    }
}

pub(super) const CAPTURE: Expect = Expect::Read {
    screenshot: true,
    depth: None,
};

impl Ticket {
    /// The exact frame sequence, or `None` for an out-of-range ticket.
    pub(super) fn expected(&self) -> Option<Vec<Expect>> {
        let mutation = matches!(
            self.admitted,
            Admitted::Click
                | Admitted::Drag
                | Admitted::Type
                | Admitted::Key { .. }
                | Admitted::Scroll { .. }
        );
        // `captureAfter` follows only a known completed mutation.
        if self.capture_after && !mutation {
            return None;
        }
        let foreground = self.delivery == Delivery::Foreground;
        let input = |steps: Vec<Expect>| {
            let mut all = if foreground {
                vec![Expect::Front]
            } else {
                Vec::new()
            };
            all.extend(steps);
            all
        };
        Some(match self.admitted {
            Admitted::Capture => vec![CAPTURE],
            Admitted::PageInfo => vec![Expect::Read {
                screenshot: true,
                depth: Some(ACCESSIBILITY_DEFAULT_DEPTH),
            }],
            Admitted::Tree { depth } => {
                if !(1..=MAX_ACCESSIBILITY_DEPTH).contains(&depth) {
                    return None;
                }
                vec![Expect::Read {
                    screenshot: false,
                    depth: Some(depth),
                }]
            }
            Admitted::Click => input(vec![Expect::Input(Tool::Click)]),
            Admitted::Drag => input(vec![Expect::Input(Tool::Drag)]),
            Admitted::Type => input(vec![Expect::Input(Tool::TypeText)]),
            Admitted::Key { chord } => input(vec![Expect::Input(if chord {
                Tool::Hotkey
            } else {
                Tool::PressKey
            })]),
            Admitted::Scroll { total, .. } => {
                if !(1..=SCROLL_TOTAL_MAX).contains(&total) {
                    return None;
                }
                let chunk = u64::try_from(SCROLL_CHUNK_MAX).ok()?;
                let chunks = usize::try_from(u64::try_from(total).ok()?.div_ceil(chunk)).ok()?;
                input(vec![Expect::ScrollChunk; chunks])
            }
            Admitted::Focus => vec![Expect::Front],
            Admitted::ListApps => vec![Expect::Plain(Tool::ListApps)],
            Admitted::ListWindows => vec![Expect::Plain(Tool::ListWindows)],
            Admitted::CheckPermissions => vec![Expect::Plain(Tool::CheckPermissions)],
            Admitted::Doctor => vec![Expect::Plain(Tool::HealthReport)],
        })
    }
}
