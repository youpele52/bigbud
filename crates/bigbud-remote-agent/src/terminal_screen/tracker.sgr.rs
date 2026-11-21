//! SGR analysis. `vt100` stores fg, bg, bold-or-dim, italic, underline and inverse. xterm.js
//! also renders blink, invisible, strikethrough, overline, underline styles and colours, and
//! bold together with dim. Those are tracked here as "unsupported" so affected rows are
//! reported through `fidelity`. Forms `vt100` misparses are rewritten before it sees them:
//! `38:2:<cs>:r:g:b` (colour-space form), `4:<style>`, and `58`/`59` with their arguments
//! (which `vt100` would otherwise read as separate SGR codes, for example `58;2;…` as dim).

use super::super::scanner::Params;
use std::io::Write as _;

const BLINK: u8 = 1;
const INVISIBLE: u8 = 1 << 1;
const STRIKE: u8 = 1 << 2;
const OVERLINE: u8 = 1 << 3;
const UNDERLINE_STYLE: u8 = 1 << 4;
const UNDERLINE_COLOR: u8 = 1 << 5;
pub(crate) const BOLD_AND_DIM: u8 = 1 << 6;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SgrPlan {
    /// Replacement bytes for `vt100`; `Some(empty)` drops the sequence entirely.
    pub(crate) rewrite: Option<Vec<u8>>,
    pub(crate) unsupported: u8,
    pub(crate) bold: bool,
    pub(crate) dim: bool,
    /// A background colour may be set (a hint for background colour erase; never false
    /// while one is set).
    pub(crate) background: bool,
}

/// Plans one SGR (`CSI … m` without private marker or intermediates).
pub(crate) fn plan_sgr(
    params: &Params,
    unsupported: u8,
    bold: bool,
    dim: bool,
    background: bool,
) -> SgrPlan {
    // At most 32 groups (`vte`'s parameter limit), kept on the stack: SGR is the hottest path.
    let mut storage: [&[u16]; super::super::scanner::MAX_PARAMS] =
        [&[]; super::super::scanner::MAX_PARAMS];
    let mut count = 0;
    for (slot, group) in storage.iter_mut().zip(params.groups()) {
        *slot = group;
        count += 1;
    }
    let groups = storage.get(..count).unwrap_or_default();
    let mut background = background;
    let mut at = 0;
    while let Some(group) = groups.get(at) {
        at += 1;
        match *group {
            [] | [0] | [49] => background = false,
            [40..=47] | [100..=107] | [48, ..] => background = true,
            _ => {}
        }
        // Semicolon colour arguments (`38;5;n`, `48;2;r;g;b`) are not SGR codes.
        if matches!(*group, [38] | [48] | [58]) {
            at += semicolon_color_args(groups, at);
        }
    }
    let mut state = (unsupported & !BOLD_AND_DIM, bold, dim);
    let mut kept = Kept::default();
    let mut rewrite = false;
    let mut index = 0;
    while let Some(group) = groups.get(index) {
        index += 1;
        let (bits, bold, dim) = &mut state;
        match *group {
            [] | [0] => {
                *bits = 0;
                *bold = false;
                *dim = false;
            }
            [1] => *bold = true,
            [2] => *dim = true,
            [22] => {
                *bold = false;
                *dim = false;
            }
            // `vt100` ignores these codes; they only change the tracked set and are never re-sent.
            [5 | 6 | 25 | 8 | 28 | 9 | 29 | 53 | 55] => {
                let code = group.first().copied().unwrap_or_default();
                let (bit, on) = match code {
                    5 | 6 => (BLINK, true),
                    25 => (BLINK, false),
                    8 => (INVISIBLE, true),
                    28 => (INVISIBLE, false),
                    9 => (STRIKE, true),
                    29 => (STRIKE, false),
                    53 => (OVERLINE, true),
                    _ => (OVERLINE, false),
                };
                set_bit(bits, bit, on);
                continue;
            }
            [21] => {
                rewrite = true;
                set_bit(bits, UNDERLINE_STYLE, true);
                kept.push(Keep::Code(4));
                continue;
            }
            [4] | [24] => *bits &= !UNDERLINE_STYLE,
            [4, style, ..] => {
                rewrite = true;
                *bits &= !UNDERLINE_STYLE;
                if *style >= 2 {
                    *bits |= UNDERLINE_STYLE;
                }
                kept.push(Keep::Code(if *style == 0 { 24 } else { 4 }));
                continue;
            }
            [58, ..] | [59] => {
                rewrite = true;
                let on = *group != [59];
                set_bit(bits, UNDERLINE_COLOR, on);
                if *group == [58] {
                    index += semicolon_color_args(groups, index);
                }
                continue;
            }
            [38 | 48, 2, _, r, g, b] => {
                rewrite = true;
                kept.push(Keep::Rgb(
                    group.first().copied().unwrap_or(38),
                    [*r, *g, *b],
                ));
                continue;
            }
            [38 | 48] => {
                let args = semicolon_color_args(groups, index);
                kept.push(Keep::Group(group));
                for arg in groups.iter().skip(index).take(args) {
                    kept.push(Keep::Group(arg));
                }
                index += args;
                continue;
            }
            _ => {}
        }
        kept.push(Keep::Group(group));
    }
    let (mut bits, bold, dim) = state;
    if bold && dim {
        bits |= BOLD_AND_DIM;
    }
    SgrPlan {
        rewrite: rewrite.then(|| encode(&kept)),
        unsupported: bits,
        bold,
        dim,
        background,
    }
}

fn set_bit(bits: &mut u8, bit: u8, on: bool) {
    if on {
        *bits |= bit;
    } else {
        *bits &= !bit;
    }
}

/// SGR codes that re-create the tracked attributes whose exact form is known (underline
/// style and colour are not kept, and stay covered by the exclusion marks). Bold with dim
/// ends on the intensity `vt100` holds (`bold_last`), since `vt100` keeps only the last one.
pub(crate) fn extras_codes(unsupported: u8, bold_last: bool) -> Vec<&'static str> {
    let both = if bold_last { "2;1" } else { "1;2" };
    [
        (BLINK, "5"),
        (INVISIBLE, "8"),
        (STRIKE, "9"),
        (OVERLINE, "53"),
        (BOLD_AND_DIM, both),
    ]
    .into_iter()
    .filter(|(bit, _)| unsupported & bit != 0)
    .map(|(_, code)| code)
    .collect()
}

/// Arguments consumed by a semicolon colour form starting at `groups[index]` (`5;n` or `2;r;g;b`).
fn semicolon_color_args(groups: &[&[u16]], index: usize) -> usize {
    match groups.get(index) {
        Some([5]) => 2,
        Some([2]) => 4,
        _ => 0,
    }
    .min(groups.len().saturating_sub(index))
}

/// One re-encoded group, borrowed from the parsed parameters where possible.
#[derive(Clone, Copy)]
enum Keep<'a> {
    Group(&'a [u16]),
    Code(u16),
    Rgb(u16, [u16; 3]),
}

/// Groups to re-send, on the stack (at most one per parsed group).
struct Kept<'a> {
    items: [Keep<'a>; super::super::scanner::MAX_PARAMS],
    len: usize,
}

impl Default for Kept<'_> {
    fn default() -> Self {
        Self {
            items: [Keep::Code(0); super::super::scanner::MAX_PARAMS],
            len: 0,
        }
    }
}

impl<'a> Kept<'a> {
    fn push(&mut self, keep: Keep<'a>) {
        if let Some(slot) = self.items.get_mut(self.len) {
            *slot = keep;
            self.len += 1;
        }
    }
}

/// Re-encodes the kept groups for `vt100` (codes only tracked here were never kept). An
/// empty result means "send nothing": `CSI m` would reset every attribute.
fn encode(kept: &Kept<'_>) -> Vec<u8> {
    let items = kept.items.get(..kept.len).unwrap_or_default();
    if items.is_empty() {
        return Vec::new();
    }
    let mut out = b"\x1b[".to_vec();
    for (position, item) in items.iter().enumerate() {
        if position > 0 {
            out.push(b';');
        }
        // Writing into a Vec cannot fail.
        let _ = match item {
            Keep::Code(code) => write!(out, "{code}"),
            Keep::Rgb(base, [r, g, b]) => write!(out, "{base};2;{r};{g};{b}"),
            Keep::Group(values) => values.iter().enumerate().try_for_each(|(sub, value)| {
                if sub > 0 {
                    out.push(b':');
                }
                write!(out, "{value}")
            }),
        };
    }
    out.push(b'm');
    out
}
