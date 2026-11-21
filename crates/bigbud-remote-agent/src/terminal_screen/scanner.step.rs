//! Per-byte transitions for every non-ground state, transcribed from `vte` 0.15
//! (`advance_esc`, `advance_csi_*`, `advance_dcs_*`, `advance_osc_string`, `anywhere`).

use super::{Kind, Scanner};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum State {
    Ground,
    Escape,
    EscapeIntermediate,
    CsiEntry,
    CsiParam,
    CsiIntermediate,
    CsiIgnore,
    DcsEntry,
    DcsParam,
    DcsIntermediate,
    DcsIgnore,
    DcsPassthrough,
    OscString,
    SosPmApcString,
}

pub(super) enum Step {
    Continue,
    /// The sequence finished with (and includes) this byte.
    Done(Kind),
    /// The sequence finished before this byte, which is an ESC that starts a new one.
    Restart(Kind),
}

const fn is_execute(byte: u8) -> bool {
    matches!(byte, 0x00..=0x17 | 0x19 | 0x1c..=0x1f)
}

impl Scanner {
    pub(super) fn step(&mut self, byte: u8) -> Step {
        match self.state {
            State::Ground => Step::Continue,
            State::Escape => self.step_escape(byte),
            State::EscapeIntermediate => match byte {
                _ if is_execute(byte) => Step::Continue,
                0x20..=0x2f => {
                    self.collect(byte);
                    Step::Continue
                }
                0x30..=0x7e => Step::Done(Kind::Esc),
                0x7f => Step::Continue,
                _ => self.anywhere(byte, Kind::Other),
            },
            State::CsiEntry | State::CsiParam => self.step_csi(byte),
            State::CsiIntermediate => match byte {
                _ if is_execute(byte) => Step::Continue,
                0x20..=0x2f => {
                    self.collect(byte);
                    Step::Continue
                }
                0x30..=0x3f => self.goto(State::CsiIgnore),
                0x40..=0x7e => self.dispatch_csi(),
                _ => self.anywhere(byte, Kind::Other),
            },
            State::CsiIgnore => match byte {
                _ if is_execute(byte) => Step::Continue,
                0x20..=0x3f | 0x7f => Step::Continue,
                0x40..=0x7e => Step::Done(Kind::Other),
                _ => self.anywhere(byte, Kind::Other),
            },
            State::DcsEntry | State::DcsParam | State::DcsIntermediate => self.step_dcs_head(byte),
            State::DcsIgnore | State::SosPmApcString => self.anywhere(byte, Kind::Other),
            State::DcsPassthrough => match byte {
                0x18 | 0x1a | 0x9c => Step::Done(Kind::Other),
                0x1b => Step::Restart(Kind::Other),
                _ => Step::Continue,
            },
            State::OscString => match byte {
                0x07 => Step::Done(Kind::Osc),
                // `vte` dispatches before executing CAN/SUB; xterm.js aborts. The tracker
                // follows xterm.js, and `vt100` still receives the raw bytes.
                0x18 | 0x1a => Step::Done(Kind::Other),
                0x1b => Step::Restart(Kind::Osc),
                _ if is_execute(byte) => Step::Continue,
                _ => {
                    self.osc_put(byte);
                    Step::Continue
                }
            },
        }
    }

    fn goto(&mut self, state: State) -> Step {
        self.state = state;
        Step::Continue
    }

    fn step_escape(&mut self, byte: u8) -> Step {
        match byte {
            _ if is_execute(byte) => Step::Continue,
            0x20..=0x2f => {
                self.collect(byte);
                self.goto(State::EscapeIntermediate)
            }
            0x50 => {
                self.params.reset();
                self.goto(State::DcsEntry)
            }
            0x58 | 0x5e | 0x5f => self.goto(State::SosPmApcString),
            0x5b => {
                self.params.reset();
                self.goto(State::CsiEntry)
            }
            0x5d => {
                self.osc.clear();
                self.osc_truncated = false;
                self.goto(State::OscString)
            }
            0x30..=0x7e => Step::Done(Kind::Esc),
            0x18 | 0x1a => Step::Done(Kind::Other),
            // ESC ESC stays in the escape state; DEL and C1 bytes are ignored.
            _ => Step::Continue,
        }
    }

    fn step_csi(&mut self, byte: u8) -> Step {
        let entry = self.state == State::CsiEntry;
        match byte {
            _ if is_execute(byte) => Step::Continue,
            0x20..=0x2f => {
                self.collect(byte);
                self.goto(State::CsiIntermediate)
            }
            0x30..=0x39 => {
                self.params.digit(byte);
                self.goto(State::CsiParam)
            }
            0x3a => {
                self.params.subparam();
                self.goto(State::CsiParam)
            }
            0x3b => {
                self.params.separator();
                self.goto(State::CsiParam)
            }
            0x3c..=0x3f if entry => {
                self.collect(byte);
                self.goto(State::CsiParam)
            }
            0x3c..=0x3f => self.goto(State::CsiIgnore),
            0x40..=0x7e => self.dispatch_csi(),
            0x7f => Step::Continue,
            _ => self.anywhere(byte, Kind::Other),
        }
    }

    fn dispatch_csi(&mut self) -> Step {
        self.params.finish();
        Step::Done(Kind::Csi)
    }

    fn step_dcs_head(&mut self, byte: u8) -> Step {
        let entry = self.state == State::DcsEntry;
        let intermediate = self.state == State::DcsIntermediate;
        match byte {
            _ if is_execute(byte) => Step::Continue,
            0x20..=0x2f => {
                self.collect(byte);
                self.goto(State::DcsIntermediate)
            }
            0x30..=0x3f if intermediate => self.goto(State::DcsIgnore),
            0x30..=0x39 => {
                self.params.digit(byte);
                self.goto(State::DcsParam)
            }
            0x3a => {
                self.params.subparam();
                self.goto(State::DcsParam)
            }
            0x3b => {
                self.params.separator();
                self.goto(State::DcsParam)
            }
            0x3c..=0x3f if entry => {
                self.collect(byte);
                self.goto(State::DcsParam)
            }
            0x3c..=0x3f => self.goto(State::DcsIgnore),
            0x40..=0x7e => {
                self.params.finish();
                self.goto(State::DcsPassthrough)
            }
            0x7f => Step::Continue,
            _ => self.anywhere(byte, Kind::Other),
        }
    }

    /// `vte`'s `anywhere`: CAN/SUB abort to ground, ESC restarts, everything else is ignored.
    fn anywhere(&mut self, byte: u8, kind: Kind) -> Step {
        match byte {
            0x18 | 0x1a => Step::Done(kind),
            0x1b => Step::Restart(kind),
            _ => Step::Continue,
        }
    }
}
