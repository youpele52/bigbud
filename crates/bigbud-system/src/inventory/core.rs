use crate::model::Availability;
use std::{
    cmp::Ordering,
    hash::{Hash, Hasher},
    time::{Duration, Instant},
};
use thiserror::Error;

pub const MAX_RECORDS: usize = 20_000;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PAGE_ROWS: usize = 100;
pub const MAX_PAGE_BYTES: usize = 128 * 1024;
const PIN_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct ProcessRecord {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub status: String,
    pub start_time_seconds: u64,
    pub run_time_seconds: u64,
    pub cpu_percent: Option<f32>,
    pub cpu_status: Availability,
    pub resident_bytes: u64,
    pub virtual_bytes: u64,
    pub disk_read_bytes: u64,
    pub disk_written_bytes: u64,
    pub disk_io_status: Availability,
}

impl ProcessRecord {
    fn estimated_bytes(&self) -> usize {
        128 + self.name.len() + self.status.len()
    }
}

#[derive(Clone, Debug)]
pub struct Inventory {
    pub generation: u64,
    pub collected_at: Instant,
    pub truncated: bool,
    rows: Vec<ProcessRecord>,
}

impl Inventory {
    pub fn from_records(
        generation: u64,
        at: Instant,
        records: impl IntoIterator<Item = ProcessRecord>,
    ) -> Self {
        let mut rows = Vec::new();
        let mut bytes = 0usize;
        let mut truncated = false;
        for mut record in records {
            record.name = truncate_utf8(&record.name, 256);
            record.status = truncate_utf8(&record.status, 256);
            let size = record.estimated_bytes();
            if rows.len() == MAX_RECORDS || bytes.saturating_add(size) > MAX_BYTES {
                truncated = true;
                break;
            }
            bytes += size;
            rows.push(record);
        }
        Self {
            generation,
            collected_at: at,
            truncated,
            rows,
        }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
    fn estimated_bytes(&self) -> usize {
        self.rows.iter().map(ProcessRecord::estimated_bytes).sum()
    }
}

pub fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    match value.get(..max_bytes) {
        Some(prefix) => prefix.to_owned(),
        None if value.len() <= max_bytes => value.to_owned(),
        None => {
            let mut end = max_bytes;
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            value.get(..end).map(str::to_owned).unwrap_or_default()
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum SortKey {
    Cpu,
    Memory,
    Name,
    Pid,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct Query {
    pub name: Option<String>,
    pub pid: Option<u32>,
    pub status: Option<String>,
    pub search: Option<String>,
    pub sort: SortKey,
    pub descending: bool,
    pub limit: usize,
}

impl Default for Query {
    fn default() -> Self {
        Self {
            name: None,
            pid: None,
            status: None,
            search: None,
            sort: SortKey::Cpu,
            descending: true,
            limit: MAX_PAGE_ROWS,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cursor {
    pub generation: u64,
    pub digest: u64,
    pub offset: usize,
}

#[derive(Clone, Debug)]
pub struct Page {
    pub rows: Vec<ProcessRecord>,
    pub next: Option<Cursor>,
    pub truncated_inventory: bool,
    pub generation: u64,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum QueryError {
    #[error("invalid process query")]
    Invalid,
    #[error("stale process query")]
    StaleQuery,
    #[error("process query busy")]
    Busy,
    #[error("process query deadline exceeded")]
    Deadline,
}

#[derive(Default)]
pub struct InventoryStore {
    current: Option<Inventory>,
    pinned: Option<(Inventory, Instant)>,
    pin_key: Option<(u64, u64)>,
    active_queries: usize,
}

impl InventoryStore {
    pub fn availability(&self, now: Instant) -> Availability {
        match self.current.as_ref() {
            None => Availability::Warming,
            Some(inventory)
                if now.saturating_duration_since(inventory.collected_at)
                    >= Duration::from_secs(10) =>
            {
                Availability::Stale
            }
            Some(_) => Availability::Ready,
        }
    }

    pub fn replace(&mut self, inventory: Inventory, now: Instant) {
        if let Some(current) = self.current.take() {
            if let Some((_, until)) = &self.pinned
                && *until <= now
            {
                self.pinned = None;
            }
            if self
                .pin_key
                .is_some_and(|(generation, _)| generation == current.generation)
                && current.estimated_bytes() + inventory.estimated_bytes() <= 16 * 1024 * 1024
            {
                self.pinned = Some((current, now + PIN_TTL));
            }
        }
        self.current = Some(inventory);
    }

    pub fn clear(&mut self) {
        self.current = None;
        self.pinned = None;
        self.pin_key = None;
    }

    pub fn query(
        &mut self,
        query: &Query,
        cursor: Option<&Cursor>,
        now: Instant,
    ) -> Result<Page, QueryError> {
        validate(query)?;
        if self.active_queries >= 2 {
            return Err(QueryError::Busy);
        }
        self.active_queries += 1;
        let result = self.query_inner(query, cursor, now);
        self.active_queries -= 1;
        result
    }

    fn query_inner(
        &mut self,
        query: &Query,
        cursor: Option<&Cursor>,
        now: Instant,
    ) -> Result<Page, QueryError> {
        let started = Instant::now();
        let digest = digest(query);
        let inventory = match cursor {
            Some(cursor) if cursor.digest != digest => return Err(QueryError::StaleQuery),
            Some(cursor) => {
                if self
                    .current
                    .as_ref()
                    .is_some_and(|i| i.generation == cursor.generation)
                {
                    self.current.as_ref()
                } else if self
                    .pinned
                    .as_ref()
                    .is_some_and(|(i, until)| i.generation == cursor.generation && *until > now)
                {
                    self.pinned.as_ref().map(|(i, _)| i)
                } else {
                    None
                }
            }
            None => self.current.as_ref(),
        }
        .ok_or(QueryError::StaleQuery)?;
        let mut rows: Vec<_> = inventory
            .rows
            .iter()
            .filter(|row| matches_query(row, query))
            .collect();
        rows.sort_unstable_by(|a, b| compare(a, b, query));
        let offset = cursor.map_or(0, |c| c.offset);
        if offset > rows.len() {
            return Err(QueryError::StaleQuery);
        }
        let mut page = Vec::new();
        let mut bytes = 0usize;
        for row in rows.iter().skip(offset).take(query.limit) {
            if started.elapsed() > Duration::from_secs(3) {
                return Err(QueryError::Deadline);
            }
            let size = row.estimated_bytes();
            if bytes + size > MAX_PAGE_BYTES {
                break;
            }
            bytes += size;
            page.push((*row).clone());
        }
        let next_offset = offset + page.len();
        let next = (next_offset < rows.len()).then_some(Cursor {
            generation: inventory.generation,
            digest,
            offset: next_offset,
        });
        let result = Page {
            rows: page,
            next,
            truncated_inventory: inventory.truncated,
            generation: inventory.generation,
        };
        if cursor.is_none() {
            let key = (result.generation, digest);
            if self.pin_key != Some(key) {
                self.pinned = None;
            }
            self.pin_key = Some(key);
        }
        Ok(result)
    }
}

fn validate(query: &Query) -> Result<(), QueryError> {
    if query.limit == 0
        || query.limit > MAX_PAGE_ROWS
        || query.name.as_ref().is_some_and(|s| s.len() > 256)
        || query.status.as_ref().is_some_and(|s| s.len() > 256)
        || query.search.as_ref().is_some_and(|s| s.len() > 256)
    {
        Err(QueryError::Invalid)
    } else {
        Ok(())
    }
}

fn digest(query: &Query) -> u64 {
    let mut state = std::collections::hash_map::DefaultHasher::new();
    query.hash(&mut state);
    state.finish()
}

fn matches_query(row: &ProcessRecord, query: &Query) -> bool {
    query.pid.is_none_or(|pid| row.pid == pid)
        && query
            .name
            .as_ref()
            .is_none_or(|name| row.name.to_lowercase().contains(&name.to_lowercase()))
        && query
            .status
            .as_ref()
            .is_none_or(|status| row.status.eq_ignore_ascii_case(status))
        && query.search.as_ref().is_none_or(|search| {
            let text = search.to_lowercase();
            row.name.to_lowercase().contains(&text)
                || row.status.to_lowercase().contains(&text)
                || search.parse::<u32>().is_ok_and(|pid| row.pid == pid)
        })
}

fn compare(a: &ProcessRecord, b: &ProcessRecord, query: &Query) -> Ordering {
    let order = match query.sort {
        SortKey::Cpu => a
            .cpu_percent
            .partial_cmp(&b.cpu_percent)
            .unwrap_or(Ordering::Equal),
        SortKey::Memory => a.resident_bytes.cmp(&b.resident_bytes),
        SortKey::Name => a.name.cmp(&b.name),
        SortKey::Pid => a.pid.cmp(&b.pid),
    };
    let order = if query.descending {
        order.reverse()
    } else {
        order
    };
    order.then_with(|| a.pid.cmp(&b.pid))
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
