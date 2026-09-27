use crate::{
    collector::{Collector, Demand},
    inventory::{Cursor, InventoryStore, Page, Query, QueryError},
    model::{Availability, Snapshot},
    recovery::{CollectionState, Recovery},
};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use thiserror::Error;

const LEASE: Duration = Duration::from_secs(15);
const SAMPLE: Duration = Duration::from_secs(1);
const IDLE: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug)]
struct Subscription {
    demand: Demand,
    expires: Instant,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ServiceError {
    #[error("monitor accepts at most two subscriptions")]
    Busy,
    #[error("unknown subscription")]
    UnknownSubscription,
}

/// Single-owner resource service. The supervisor schedules `tick`; this type never starts a thread.
/// Each tick runs at most one collector pass. Expired leases end demand automatically.
pub struct Service {
    collector: Collector,
    inventories: InventoryStore,
    subscriptions: BTreeMap<u64, Subscription>,
    next_id: u64,
    last_sample: Option<Instant>,
    idle_since: Option<Instant>,
    latest: Option<Snapshot>,
    recovery: Recovery,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            collector: Collector::new(),
            inventories: InventoryStore::default(),
            subscriptions: BTreeMap::new(),
            next_id: 1,
            last_sample: None,
            idle_since: None,
            latest: None,
            recovery: Recovery::default(),
        }
    }
}

impl Service {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&mut self, demand: Demand, now: Instant) -> Result<u64, ServiceError> {
        if self.subscriptions.len() >= 2 {
            return Err(ServiceError::Busy);
        }
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.subscriptions.insert(
            id,
            Subscription {
                demand,
                expires: now + LEASE,
            },
        );
        self.idle_since = None;
        Ok(id)
    }

    pub fn renew(&mut self, id: u64, demand: Demand, now: Instant) -> Result<(), ServiceError> {
        let subscription = self
            .subscriptions
            .get_mut(&id)
            .ok_or(ServiceError::UnknownSubscription)?;
        subscription.demand = demand;
        subscription.expires = now + LEASE;
        Ok(())
    }

    pub fn unsubscribe(&mut self, id: u64) -> Result<(), ServiceError> {
        self.unsubscribe_at(id, Instant::now())
    }

    pub fn unsubscribe_at(&mut self, id: u64, now: Instant) -> Result<(), ServiceError> {
        self.subscriptions
            .remove(&id)
            .ok_or(ServiceError::UnknownSubscription)?;
        if self.subscriptions.is_empty() {
            self.idle_since = Some(now);
        }
        Ok(())
    }

    pub fn latest(&self) -> Option<&Snapshot> {
        self.latest.as_ref()
    }
    pub fn subscription_count(&self) -> usize {
        self.subscriptions.len()
    }

    pub fn collection_state(&self) -> CollectionState {
        self.recovery.state()
    }

    /// Explicit recovery request; preserves subscriptions but starts a fresh baseline.
    pub fn retry_collection(&mut self) {
        self.collector.reset();
        self.inventories.clear();
        self.latest = None;
        self.last_sample = None;
        self.recovery.retry();
    }

    /// Rust-owned summary freshness. Transport disconnect is reported by the caller separately.
    pub fn summary_availability(&self, now: Instant) -> Availability {
        match self.last_sample {
            None => Availability::Warming,
            Some(last) if now.saturating_duration_since(last) >= Duration::from_secs(5) => {
                Availability::Stale
            }
            Some(_) => Availability::Ready,
        }
    }

    /// Returns a new snapshot only when demand exists and the one-second cadence is due.
    pub fn tick(&mut self, now: Instant) -> Option<&Snapshot> {
        self.subscriptions
            .retain(|_, subscription| subscription.expires > now);
        if self.subscriptions.is_empty() {
            let since = self.idle_since.get_or_insert(now);
            if now.saturating_duration_since(*since) >= IDLE {
                self.collector.reset();
                self.inventories.clear();
                self.latest = None;
                self.last_sample = None;
                self.idle_since = None;
            }
            return None;
        }
        self.idle_since = None;
        if self
            .last_sample
            .is_some_and(|last| now.saturating_duration_since(last) > Duration::from_secs(30))
        {
            self.collector.reset();
            self.inventories.clear();
            self.latest = None;
            self.last_sample = None;
        }
        if self
            .last_sample
            .is_some_and(|last| now.saturating_duration_since(last) < SAMPLE)
        {
            return None;
        }
        let demand = Demand {
            processes: self.subscriptions.values().any(|s| s.demand.processes),
            sensors: self.subscriptions.values().any(|s| s.demand.sensors),
            disks: self.subscriptions.values().any(|s| s.demand.disks),
        };
        if !demand.processes {
            self.inventories.clear();
            self.collector.release_processes();
        }
        if !self.recovery.can_sample(now) {
            return None;
        }
        let (snapshot, inventory) = match self.collector.sample_checked(demand, now) {
            Ok(result) => {
                self.recovery.success();
                result
            }
            Err(reason) => {
                self.recovery.failure(now, reason);
                self.collector.reset();
                self.inventories.clear();
                return None;
            }
        };
        if let Some(inventory) = inventory {
            self.inventories.replace(inventory, now);
        }
        self.latest = Some(snapshot);
        self.last_sample = Some(now);
        self.latest.as_ref()
    }

    pub fn process_availability(&self, now: Instant) -> Availability {
        self.inventories.availability(now)
    }

    pub fn query(
        &mut self,
        query: &Query,
        cursor: Option<&Cursor>,
        now: Instant,
    ) -> Result<Page, QueryError> {
        self.inventories.query(query, cursor, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_sampler_leases_and_idle_release() {
        let start = Instant::now();
        let mut service = Service::new();
        let id = service.subscribe(Demand::default(), start).unwrap();
        let _second = service
            .subscribe(
                Demand {
                    disks: true,
                    ..Demand::default()
                },
                start,
            )
            .unwrap();
        assert_eq!(
            service.subscribe(Demand::default(), start),
            Err(ServiceError::Busy)
        );
        assert!(service.tick(start).is_some());
        assert!(service.tick(start + Duration::from_millis(500)).is_none());
        service
            .renew(id, Demand::default(), start + Duration::from_secs(5))
            .unwrap();
        assert!(service.tick(start + Duration::from_secs(16)).is_some());
        assert_eq!(service.subscription_count(), 1);
        assert!(service.tick(start + Duration::from_secs(21)).is_none());
        assert!(service.tick(start + Duration::from_secs(31)).is_none());
        assert!(service.latest().is_none());
    }
    #[test]
    fn long_gap_restarts_rate_baseline() {
        let at = Instant::now();
        let mut service = Service::new();
        let id = service.subscribe(Demand::default(), at).unwrap();
        assert!(service.tick(at).is_some());
        service
            .renew(id, Demand::default(), at + Duration::from_secs(29))
            .unwrap();
        let sample = service.tick(at + Duration::from_secs(31)).unwrap();
        assert_eq!(sample.cpu.total_percent.status, Availability::Warming);
    }
    #[test]
    fn stopping_process_demand_releases_inventory() {
        let at = Instant::now();
        let mut service = Service::new();
        let id = service
            .subscribe(
                Demand {
                    processes: true,
                    ..Demand::default()
                },
                at,
            )
            .unwrap();
        assert!(service.tick(at).is_some());
        assert_eq!(service.process_availability(at), Availability::Ready);
        service
            .renew(id, Demand::default(), at + Duration::from_secs(1))
            .unwrap();
        assert!(service.tick(at + Duration::from_secs(1)).is_some());
        assert_eq!(
            service.process_availability(at + Duration::from_secs(1)),
            Availability::Warming
        );
    }
    #[test]
    fn explicit_unsubscribe_starts_idle_deadline_immediately() {
        let at = Instant::now();
        let mut service = Service::new();
        let id = service.subscribe(Demand::default(), at).unwrap();
        assert!(service.tick(at).is_some());
        service
            .unsubscribe_at(id, at + Duration::from_secs(1))
            .unwrap();
        assert!(service.tick(at + Duration::from_secs(11)).is_none());
        assert!(service.latest().is_none());
    }
    #[test]
    fn terminal_collection_failure_waits_for_manual_retry() {
        use crate::collector::CollectionError;
        let at = Instant::now();
        let mut service = Service::new();
        let _id = service.subscribe(Demand::default(), at).unwrap();
        assert!(service.tick(at).is_some());
        service
            .recovery
            .failure(at + Duration::from_secs(1), CollectionError::MissingCpu);
        service
            .recovery
            .failure(at + Duration::from_secs(2), CollectionError::MissingCpu);
        service
            .recovery
            .failure(at + Duration::from_secs(3), CollectionError::MissingMemory);
        assert_eq!(
            service.collection_state(),
            CollectionState::Failed {
                reason: CollectionError::MissingMemory
            }
        );
        assert!(service.tick(at + Duration::from_secs(4)).is_none());
        service.retry_collection();
        assert_eq!(service.collection_state(), CollectionState::Healthy);
        assert_eq!(service.subscription_count(), 1);
        let sample = service.tick(at + Duration::from_secs(5)).unwrap();
        assert_eq!(sample.cpu.total_percent.status, Availability::Warming);
    }
}
