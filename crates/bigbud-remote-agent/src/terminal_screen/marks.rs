//! Conservative bookkeeping of rows that may differ from xterm.js for a documented reason.
//!
//! Normal-screen rows are numbered absolutely (`discarded + scrollback_len + visible_row`), which
//! stays stable while rows scroll into, and out of, scrollback. A mark always covers the whole
//! visible screen from activation to deactivation: content can move within the visible screen
//! (IL/DL, scroll regions) but can only leave it by scrolling into scrollback or being erased,
//! so the count never under-reports. Over-reporting only lowers `fidelity` to `trimmed`.

/// Mark kinds; the index into the per-kind arrays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MarkKind {
    Osc8Link = 0,
    UnsupportedAttribute = 1,
    UnsupportedMode = 2,
}

const KINDS: usize = 3;
/// Bound on retained ranges per kind; beyond it the oldest two merge into their hull.
const MAX_RANGES: usize = 1024;

/// The normal screen's visible window in absolute row numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Window {
    pub(crate) top: u64,
    pub(crate) rows: u16,
}

impl Window {
    pub(crate) fn bottom(self) -> u64 {
        self.top + u64::from(self.rows).saturating_sub(1)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Marks {
    ranges: [Vec<(u64, u64)>; KINDS],
    open: [Option<u64>; KINDS],
    alt: [bool; KINDS],
    reflow_before: Option<u64>,
    alt_reflow: bool,
}

impl Marks {
    pub(crate) fn activate(&mut self, kind: MarkKind, window: Option<Window>) {
        let index = kind as usize;
        match window {
            None => set(&mut self.alt, index, true),
            Some(window) => {
                if let Some(slot) = self.open.get_mut(index) {
                    slot.get_or_insert(window.top);
                }
            }
        }
    }

    /// `window` is `None` while the alternate screen is active.
    pub(crate) fn deactivate(&mut self, kind: MarkKind, window: Option<Window>) {
        let index = kind as usize;
        let Some(window) = window else {
            return;
        };
        let start = self.open.get_mut(index).and_then(Option::take);
        if let (Some(start), Some(ranges)) = (start, self.ranges.get_mut(index)) {
            ranges.push((start, window.bottom()));
            if ranges.len() > MAX_RANGES {
                let merged = ranges.drain(..2).fold((u64::MAX, 0), |acc, range| {
                    (acc.0.min(range.0), acc.1.max(range.1))
                });
                ranges.insert(0, merged);
            }
        }
    }

    /// The alternate screen was cleared (entered, erased with ED 2, or reset).
    pub(crate) fn clear_alt(&mut self) {
        self.alt = [false; KINDS];
        self.alt_reflow = false;
    }

    /// After a width change, normal rows numbered below `boundary` predate it, and so does
    /// the alternate screen's content when it is active.
    pub(crate) fn width_changed(&mut self, alt_active: bool, boundary: u64) {
        self.reflow_before = Some(boundary);
        self.alt_reflow = alt_active || self.alt_reflow;
    }

    /// Drops ranges that ended above `oldest`, the first retained absolute row.
    pub(crate) fn prune(&mut self, oldest: u64) {
        for ranges in &mut self.ranges {
            ranges.retain(|range| range.1 >= oldest);
        }
    }

    /// Rows of `kind` within the emitted normal rows `[low, high]`, or on the alternate screen.
    pub(crate) fn count(&self, kind: MarkKind, emitted: Option<(u64, u64)>, alt_rows: u16) -> u32 {
        let index = kind as usize;
        let mut total = 0u64;
        if self.alt.get(index).copied().unwrap_or(false) {
            total += u64::from(alt_rows);
        }
        if let Some((low, high)) = emitted {
            let mut spans: Vec<(u64, u64)> = self.ranges.get(index).cloned().unwrap_or_default();
            if let Some(start) = self.open.get(index).copied().flatten() {
                spans.push((start, high));
            }
            total += union_within(&mut spans, low, high);
        }
        u32::try_from(total).unwrap_or(u32::MAX)
    }

    /// Normal rows written before the last width change, plus the alternate screen if it was.
    pub(crate) fn reflow_rows(&self, emitted: Option<(u64, u64)>, alt_rows: u16) -> u32 {
        let mut total = if self.alt_reflow {
            u64::from(alt_rows)
        } else {
            0
        };
        if let (Some(before), Some((low, high))) = (self.reflow_before, emitted)
            && before > low
        {
            total += high.min(before - 1) - low + 1;
        }
        u32::try_from(total).unwrap_or(u32::MAX)
    }

    /// True when normal row `row` may differ for any documented reason (reflow or a mark).
    #[cfg(test)]
    pub(crate) fn covers(&self, row: u64) -> bool {
        let in_ranges = self
            .ranges
            .iter()
            .flatten()
            .any(|(start, end)| (*start..=*end).contains(&row));
        let open = self.open.iter().flatten().any(|start| row >= *start);
        in_ranges || open || self.reflow_before.is_some_and(|before| row < before)
    }

    /// True when the alternate screen may differ for a documented reason.
    #[cfg(test)]
    pub(crate) fn alt_covered(&self) -> bool {
        self.alt_reflow || self.alt.iter().any(|flag| *flag)
    }

    /// Re-expresses marks relative to a restored model whose first row is `first_emitted`.
    pub(crate) fn rebase(&self, first_emitted: u64) -> Self {
        let shift = |row: u64| row.saturating_sub(first_emitted);
        let mut rebased = self.clone();
        for ranges in &mut rebased.ranges {
            ranges.retain(|range| range.1 >= first_emitted);
            for range in ranges.iter_mut() {
                *range = (shift(range.0), shift(range.1));
            }
        }
        for open in rebased.open.iter_mut().flatten() {
            *open = shift(*open);
        }
        rebased.reflow_before = self
            .reflow_before
            .filter(|before| *before > first_emitted)
            .map(shift);
        rebased
    }
}

/// Checkpoint encoding (big-endian, length-prefixed); see `checkpoint.rs`.
impl Marks {
    pub(crate) fn encode(&self, out: &mut Vec<u8>) {
        for index in 0..KINDS {
            let ranges = self.ranges.get(index).map_or(&[][..], Vec::as_slice);
            out.extend_from_slice(&u32::try_from(ranges.len()).unwrap_or(0).to_be_bytes());
            for (start, end) in ranges {
                out.extend_from_slice(&start.to_be_bytes());
                out.extend_from_slice(&end.to_be_bytes());
            }
            encode_option(out, self.open.get(index).copied().flatten());
            out.push(u8::from(self.alt.get(index).copied().unwrap_or(false)));
        }
        encode_option(out, self.reflow_before);
        out.push(u8::from(self.alt_reflow));
    }

    pub(crate) fn decode(input: &mut &[u8]) -> Option<Self> {
        let mut marks = Self::default();
        for index in 0..KINDS {
            let count = usize::try_from(take_u32(input)?).ok()?;
            if count > MAX_RANGES {
                return None;
            }
            let mut ranges = Vec::with_capacity(count);
            for _ in 0..count {
                ranges.push((take_u64(input)?, take_u64(input)?));
            }
            *marks.ranges.get_mut(index)? = ranges;
            *marks.open.get_mut(index)? = decode_option(input)?;
            *marks.alt.get_mut(index)? = take_u8(input)? != 0;
        }
        marks.reflow_before = decode_option(input)?;
        marks.alt_reflow = take_u8(input)? != 0;
        Some(marks)
    }
}

fn encode_option(out: &mut Vec<u8>, value: Option<u64>) {
    out.push(u8::from(value.is_some()));
    out.extend_from_slice(&value.unwrap_or(0).to_be_bytes());
}

fn decode_option(input: &mut &[u8]) -> Option<Option<u64>> {
    let present = take_u8(input)? != 0;
    let value = take_u64(input)?;
    Some(present.then_some(value))
}

pub(crate) fn take<'a>(input: &mut &'a [u8], length: usize) -> Option<&'a [u8]> {
    let (head, rest) = input.split_at_checked(length)?;
    *input = rest;
    Some(head)
}

pub(crate) fn take_u8(input: &mut &[u8]) -> Option<u8> {
    take(input, 1)?.first().copied()
}

pub(crate) fn take_u32(input: &mut &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(take(input, 4)?.try_into().ok()?))
}

pub(crate) fn take_u64(input: &mut &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(take(input, 8)?.try_into().ok()?))
}

fn set(flags: &mut [bool; KINDS], index: usize, value: bool) {
    if let Some(flag) = flags.get_mut(index) {
        *flag = value;
    }
}

fn union_within(spans: &mut [(u64, u64)], low: u64, high: u64) -> u64 {
    spans.sort_unstable();
    let mut total = 0u64;
    let mut covered_to: Option<u64> = None;
    for &(start, end) in spans.iter() {
        let start = start.max(low);
        let end = end.min(high);
        if start > end {
            continue;
        }
        let start = match covered_to {
            Some(covered) if covered >= end => continue,
            Some(covered) if covered >= start => covered + 1,
            _ => start,
        };
        total += end - start + 1;
        covered_to = Some(end);
    }
    total
}
