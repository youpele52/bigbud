//! Terminal queries the host answers while no renderer is attached (§8.9).
//!
//! R1 detects queries and captures the state each reply depends on at the exact point the
//! query appears in the output; R5 decides whether to reply (the sequence cut `C`) and
//! formats replies with [`reply`]. Replies match what xterm.js reports. Every other query,
//! including clipboard and title reports, is never answered.

/// Whether a mode queried with DECRQM is set, as captured when the query was parsed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeState {
    Set,
    Reset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectedQuery {
    /// DA1: `CSI c` or `CSI 0 c`.
    PrimaryDeviceAttributes,
    /// DSR: `CSI 5 n`.
    DeviceStatus,
    /// CPR: `CSI 6 n`, with the 1-based cursor position when the query was parsed.
    CursorPosition { row: u16, col: u16 },
    /// OSC 10 `?`.
    ForegroundColor,
    /// OSC 11 `?`.
    BackgroundColor,
    /// DECRQM (`CSI ? Ps $ p` when `private`, otherwise `CSI Ps $ p`) for a tracked mode.
    ModeStatus {
        private: bool,
        mode: u16,
        state: ModeState,
    },
}

/// Theme colours the server pushes with `PtyViewState`; `None` means "do not answer".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReplyContext {
    pub foreground: Option<[u8; 3]>,
    pub background: Option<[u8; 3]>,
}

/// The xterm.js reply for `query`, or `None` when the host must stay silent.
pub fn reply(query: &DetectedQuery, context: &ReplyContext) -> Option<Vec<u8>> {
    let text = match *query {
        // xterm.js identifies as a VT100 with advanced video option.
        DetectedQuery::PrimaryDeviceAttributes => "\x1b[?1;2c".to_owned(),
        DetectedQuery::DeviceStatus => "\x1b[0n".to_owned(),
        DetectedQuery::CursorPosition { row, col } => format!("\x1b[{row};{col}R"),
        DetectedQuery::ForegroundColor => color_reply(10, context.foreground?),
        DetectedQuery::BackgroundColor => color_reply(11, context.background?),
        DetectedQuery::ModeStatus {
            private,
            mode,
            state,
        } => {
            let marker = if private { "?" } else { "" };
            let value = match state {
                ModeState::Set => 1,
                ModeState::Reset => 2,
            };
            format!("\x1b[{marker}{mode};{value}$y")
        }
    };
    Some(text.into_bytes())
}

/// xterm.js reports colours as 16-bit `rgb:` components terminated with ST.
fn color_reply(ident: u8, [red, green, blue]: [u8; 3]) -> String {
    let wide = |channel: u8| u16::from(channel) * 0x101;
    format!(
        "\x1b]{ident};rgb:{:04x}/{:04x}/{:04x}\x1b\\",
        wide(red),
        wide(green),
        wide(blue)
    )
}

/// Parses the OSC payload of a colour query: `10;?`, `11;?`, or xterm's `10;?;?` form, where
/// each further `?` queries the next colour number.
pub(crate) fn color_queries(payload: &[u8], out: &mut Vec<DetectedQuery>) {
    let mut fields = payload.split(|byte| *byte == b';');
    let first = match fields.next() {
        Some(b"10") => 10u8,
        Some(b"11") => 11u8,
        _ => return,
    };
    for (offset, field) in fields.enumerate() {
        if field != b"?" {
            continue;
        }
        match first.saturating_add(u8::try_from(offset).unwrap_or(u8::MAX)) {
            10 => out.push(DetectedQuery::ForegroundColor),
            11 => out.push(DetectedQuery::BackgroundColor),
            _ => {}
        }
    }
}
