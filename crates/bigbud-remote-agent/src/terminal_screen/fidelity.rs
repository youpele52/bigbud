//! How faithfully a snapshot reproduces what xterm.js would show (§15 R1 pass criteria).
//!
//! Every known difference category is reported; none is silent. `trimmed` means some rows
//! may differ for a documented reason, or were dropped to fit the snapshot caps; the session
//! stays restorable. `partial` means the model was rebuilt from incomplete output and the
//! session must not be parked.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fidelity {
    Full,
    Trimmed,
    Partial,
}

impl Fidelity {
    /// The wire value for `PtyScreenSnapshotHeader.fidelity`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Trimmed => "trimmed",
            Self::Partial => "partial",
        }
    }
}

/// Documented exclusions from the zero-diff criterion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExclusionKind {
    /// Rows written before the last width change: `vt100` truncates, xterm.js reflows.
    ReflowAfterWidthChange,
    /// Rows that showed OSC 8 links: `vt100` keeps the text, not the link target.
    Osc8LinkTargets,
    /// Rows that showed attributes `vt100` cannot store: blink, invisible, strikethrough,
    /// overline, underline style or colour, or bold together with dim.
    UnsupportedAttributes,
    /// Rows written while autowrap was off, insert mode was on, or reverse wraparound was
    /// on: `vt100` implements none of them, so output can land elsewhere than in xterm.js.
    UnsupportedModes,
    /// Kitty keyboard flags; xterm.js does not implement them, so they are host state only
    /// and never affect rows (always reported with `rows = 0`).
    KittyKeyboardHostOnly,
}

impl ExclusionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReflowAfterWidthChange => "reflow_after_width_change",
            Self::Osc8LinkTargets => "osc8_link_targets",
            Self::UnsupportedAttributes => "unsupported_attributes",
            Self::UnsupportedModes => "unsupported_modes",
            Self::KittyKeyboardHostOnly => "kitty_keyboard_host_only",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exclusion {
    pub kind: ExclusionKind,
    /// Emitted rows that may differ (an upper bound; never an under-count).
    pub rows: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FidelityReport {
    pub fidelity: Fidelity,
    /// Oldest scrollback rows dropped so the snapshot fits both caps.
    pub trimmed_rows: u32,
    /// Exclusions that apply to this snapshot (kinds with no affected rows are omitted,
    /// except kitty keyboard state, which is listed whenever it is in use).
    pub exclusions: Vec<Exclusion>,
}

impl FidelityReport {
    pub(crate) fn new(partial: bool, trimmed_rows: u32, exclusions: Vec<Exclusion>) -> Self {
        let fidelity = if partial {
            Fidelity::Partial
        } else if trimmed_rows > 0 || exclusions.iter().any(|exclusion| exclusion.rows > 0) {
            Fidelity::Trimmed
        } else {
            Fidelity::Full
        };
        Self {
            fidelity,
            trimmed_rows,
            exclusions,
        }
    }

    /// Rows reported as `trimmed`: dropped rows plus every row covered by an exclusion.
    pub fn affected_rows(&self) -> u32 {
        self.exclusions
            .iter()
            .fold(self.trimmed_rows, |total, exclusion| {
                total.saturating_add(exclusion.rows)
            })
    }
}
