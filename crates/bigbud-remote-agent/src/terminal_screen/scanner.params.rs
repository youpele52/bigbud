//! CSI/DCS parameter collection that mirrors `vte` 0.15 (`Params`, `action_param`,
//! `action_subparam`, `action_paramnext`), so the scanner sees exactly the groups `vt100` sees.

/// `vte::params::MAX_PARAMS`.
pub(crate) const MAX_PARAMS: usize = 32;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Params {
    values: [u16; MAX_PARAMS],
    /// Bit `i` is set when value `i` closes a parameter group (`;` or the final byte).
    group_ends: u32,
    len: usize,
    current: u16,
    pub(crate) ignoring: bool,
}

impl Params {
    pub(crate) fn reset(&mut self) {
        self.group_ends = 0;
        self.len = 0;
        self.current = 0;
        self.ignoring = false;
    }

    fn is_full(&self) -> bool {
        self.len >= MAX_PARAMS
    }

    pub(crate) fn digit(&mut self, byte: u8) {
        if self.is_full() {
            self.ignoring = true;
            return;
        }
        self.current = self
            .current
            .saturating_mul(10)
            .saturating_add(u16::from(byte.saturating_sub(b'0')));
    }

    fn store(&mut self, closes_group: bool) {
        if self.is_full() {
            self.ignoring = true;
            return;
        }
        if let Some(slot) = self.values.get_mut(self.len) {
            *slot = self.current;
        }
        if closes_group {
            self.group_ends |= 1 << self.len;
        }
        self.len += 1;
        self.current = 0;
    }

    /// `;` closes the current group.
    pub(crate) fn separator(&mut self) {
        self.store(true);
    }

    /// `:` extends the current group with a sub-parameter.
    pub(crate) fn subparam(&mut self) {
        self.store(false);
    }

    /// The final byte pushes the pending value, as `vte` does before dispatching.
    pub(crate) fn finish(&mut self) {
        self.store(true);
    }

    pub(crate) fn groups(&self) -> ParamGroups<'_> {
        ParamGroups {
            params: self,
            index: 0,
        }
    }

    /// First value of the first group, or 0 when there are no parameters.
    pub(crate) fn first(&self) -> u16 {
        self.groups()
            .next()
            .and_then(|g| g.first().copied())
            .unwrap_or(0)
    }

    pub(crate) fn group_count(&self) -> usize {
        self.groups().count()
    }

    /// True when every group holds a single zero value (`CSI c`, `CSI 0 c`).
    pub(crate) fn all_zero(&self) -> bool {
        self.groups().all(|g| g.iter().all(|v| *v == 0))
    }
}

pub(crate) struct ParamGroups<'a> {
    params: &'a Params,
    index: usize,
}

impl<'a> Iterator for ParamGroups<'a> {
    type Item = &'a [u16];

    fn next(&mut self) -> Option<Self::Item> {
        let start = self.index;
        let len = self.params.len;
        if start >= len {
            return None;
        }
        let mut end = start;
        while end < len {
            let closes = self.params.group_ends & (1 << end) != 0;
            end += 1;
            if closes {
                break;
            }
        }
        self.index = end;
        self.params.values.get(start..end)
    }
}
