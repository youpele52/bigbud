//! Tab stops, as xterm.js keeps them (`setupTabStops`, `nextStop`, `prevStop`): per screen,
//! a stop at every 8th column from column 0 until HTS or TBC changes them; the alternate
//! screen's stops return to the default when it is cleared on exit. `vt100` only knows the
//! default stops, so TAB, CHT and CBT are applied here once the stops are custom.

use super::Tracker;

impl Tracker {
    fn active_stops(&self) -> Option<&Vec<bool>> {
        self.tab_stops
            .get(usize::from(self.alt_active))
            .and_then(Option::as_ref)
    }

    fn stops_mut(&mut self, cols: u16) -> &mut Vec<bool> {
        let index = usize::from(self.alt_active);
        let [normal, alternate] = &mut self.tab_stops;
        let slot = if index == 0 { normal } else { alternate };
        let stops =
            slot.get_or_insert_with(|| (0..cols).map(|col| col.is_multiple_of(8)).collect());
        stops.resize(usize::from(cols), false);
        stops
    }

    /// True when the active screen's stops are custom (TAB must be applied here).
    pub(crate) fn custom_tabs_active(&self) -> bool {
        self.active_stops().is_some()
    }

    /// HTS at `col`.
    pub(crate) fn set_tab_stop(&mut self, col: u16, cols: u16) {
        if let Some(stop) = self.stops_mut(cols).get_mut(usize::from(col)) {
            *stop = true;
        }
    }

    /// TBC: `0` clears the stop at `col`, `3` clears every stop.
    pub(crate) fn clear_tab_stops(&mut self, mode: u16, col: u16, cols: u16) {
        let stops = self.stops_mut(cols);
        match mode {
            0 => {
                if let Some(stop) = stops.get_mut(usize::from(col)) {
                    *stop = false;
                }
            }
            3 => stops.iter_mut().for_each(|stop| *stop = false),
            _ => {}
        }
    }

    /// New columns get default stops, like xterm.js on resize.
    pub(crate) fn resize_tab_stops(&mut self, cols: u16) {
        for stops in self.tab_stops.iter_mut().flatten() {
            let old = u16::try_from(stops.len()).unwrap_or(u16::MAX);
            stops.extend((old..cols).map(|col| col.is_multiple_of(8)));
            stops.truncate(usize::from(cols));
        }
    }

    fn is_stop(&self, col: u16) -> bool {
        match self.active_stops() {
            Some(stops) => stops.get(usize::from(col)).copied().unwrap_or(false),
            None => col.is_multiple_of(8),
        }
    }

    /// xterm.js `nextStop`, `count` times from `col` (which is below `cols`).
    pub(crate) fn next_tab_stop(&self, mut col: u16, cols: u16, count: u16) -> u16 {
        for _ in 0..count.max(1) {
            col += 1;
            while col < cols && !self.is_stop(col) {
                col += 1;
            }
        }
        col.min(cols - 1)
    }

    /// xterm.js `prevStop`, `count` times from `col`.
    pub(crate) fn previous_tab_stop(&self, mut col: u16, count: u16) -> u16 {
        for _ in 0..count.max(1) {
            col = col.saturating_sub(1);
            while col > 0 && !self.is_stop(col) {
                col -= 1;
            }
        }
        col
    }

    /// Custom stops of screen `index` (0 normal, 1 alternate), in column order, for the
    /// snapshot (`None` while they are the default).
    pub(crate) fn custom_tab_stops(&self, index: usize) -> Option<Vec<u16>> {
        let stops = self.tab_stops.get(index)?.as_ref()?;
        let default = stops
            .iter()
            .enumerate()
            .all(|(col, stop)| *stop == (col.is_multiple_of(8)));
        (!default).then(|| {
            stops
                .iter()
                .enumerate()
                .filter(|(_, stop)| **stop)
                .filter_map(|(col, _)| u16::try_from(col).ok())
                .collect()
        })
    }
}
