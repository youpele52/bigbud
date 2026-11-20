use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Interactive searches allowed at once per session; a third is refused with `SEARCH_BUSY`.
pub const MAX_CONCURRENT_SEARCHES: usize = 2;

/// In-flight searches keyed by `operation_id`, so `CancelRequest` can stop them. Deliberately
/// separate from the accepted-operation table: a search per keystroke must never evict process
/// identities, and searches are idempotent, never journalled and never replayed.
#[derive(Debug, Clone, Default)]
pub struct SearchRegistry {
    inflight: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SearchRegisterError {
    #[error("too many workspace searches are running")]
    Busy,
    #[error("a workspace search with this operation id is already running")]
    Duplicate,
    #[error("workspace search operation id is required")]
    MissingOperationId,
    #[error("workspace search registry lock was poisoned")]
    Poisoned,
}

impl SearchRegisterError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Busy => "SEARCH_BUSY",
            Self::Duplicate => "OPERATION_ID_CONFLICT",
            Self::MissingOperationId => "MISSING_OPERATION_ID",
            Self::Poisoned => "INTERNAL",
        }
    }
}

/// Owns one registry slot; dropping it frees the slot, whatever way the search ended.
#[derive(Debug)]
pub struct SearchTicket {
    registry: SearchRegistry,
    operation_id: String,
    cancel: Arc<AtomicBool>,
}

impl SearchTicket {
    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
}

impl Drop for SearchTicket {
    fn drop(&mut self) {
        // A poisoned lock means another thread panicked mid-update; the slot is then leaked
        // rather than risking a second panic during unwinding.
        if let Ok(mut inflight) = self.registry.inflight.lock() {
            inflight.remove(&self.operation_id);
        }
    }
}

impl SearchRegistry {
    pub fn register(&self, operation_id: &str) -> Result<SearchTicket, SearchRegisterError> {
        if operation_id.is_empty() {
            return Err(SearchRegisterError::MissingOperationId);
        }
        let mut inflight = self
            .inflight
            .lock()
            .map_err(|_| SearchRegisterError::Poisoned)?;
        if inflight.contains_key(operation_id) {
            return Err(SearchRegisterError::Duplicate);
        }
        if inflight.len() >= MAX_CONCURRENT_SEARCHES {
            return Err(SearchRegisterError::Busy);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        inflight.insert(operation_id.to_owned(), Arc::clone(&cancel));
        Ok(SearchTicket {
            registry: self.clone(),
            operation_id: operation_id.to_owned(),
            cancel,
        })
    }

    /// Signals the search; returns whether it was running.
    pub fn cancel(&self, operation_id: &str) -> bool {
        let Ok(inflight) = self.inflight.lock() else {
            return false;
        };
        match inflight.get(operation_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Signals every running search (connection loss, shutdown).
    pub fn cancel_all(&self) {
        if let Ok(inflight) = self.inflight.lock() {
            for flag in inflight.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn len(&self) -> usize {
        self.inflight.lock().map_or(0, |inflight| inflight.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
