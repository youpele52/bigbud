use super::frame::{error, wrap};
use super::{app_resources, collection_status, frame, mapping, query};

use std::{
    collections::BTreeMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::monitor_v1 as v1;
use bigbud_system::{
    collector::{Demand, host_identity},
    lifecycle::Service,
};

const ACK_TIMEOUT: Duration = Duration::from_secs(5);
const LEASE: Duration = Duration::from_secs(15);

struct Subscription {
    sequence: u64,
    awaiting: Option<(u64, Instant)>,
    pending: Option<v1::Snapshot>,
    expires: Instant,
}

pub(super) struct State {
    service: Service,
    subscriptions: BTreeMap<u64, Subscription>,
    epoch: u64,
    greeted: bool,
    minor: u32,
}

impl State {
    pub(super) fn new() -> Self {
        let epoch = SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |d| {
            (d.as_millis() as u64)
                .saturating_mul(1000)
                .saturating_add(u64::from(std::process::id() % 1000))
        });
        Self {
            service: Service::new(),
            subscriptions: BTreeMap::new(),
            epoch,
            greeted: false,
            minor: 0,
        }
    }

    pub(super) fn handle(&mut self, frame: v1::Frame, now: Instant) -> (Vec<v1::Frame>, bool) {
        use v1::frame::Payload;
        let Some(payload) = frame.payload else {
            return (vec![error(0, 0, "invalid", "empty frame")], false);
        };
        if let Payload::Hello(hello) = payload {
            if self.greeted || hello.major != 1 {
                return (vec![error(0, 0, "version", "incompatible protocol")], true);
            }
            self.greeted = true;
            let minor = hello.minor.min(3);
            self.minor = minor;
            let mut capabilities = vec![
                "snapshot".into(),
                "process-query".into(),
                "retry".into(),
                "collection-status".into(),
            ];
            if minor >= 3 {
                capabilities.push("app-resources".into());
            }
            let identity = (minor >= 1).then(host_identity);
            return (
                vec![
                    wrap(Payload::HelloAck(v1::HelloAck {
                        major: 1,
                        minor,
                        maximum_frame_bytes: frame::MAX_FRAME as u32,
                        maximum_subscriptions: 2,
                        epoch: self.epoch,
                        capabilities,
                        hostname: identity.as_ref().and_then(|host| host.hostname.clone()),
                        os_name: identity.as_ref().and_then(|host| host.os_name.clone()),
                        os_version: identity.as_ref().and_then(|host| host.os_version.clone()),
                        architecture: identity.and_then(|host| host.architecture),
                    })),
                    collection_status::frame(&self.service, self.epoch, now),
                ],
                false,
            );
        }
        if !self.greeted {
            return (vec![error(0, 0, "handshake", "hello required")], true);
        }
        match payload {
            Payload::Subscribe(request) => {
                let roots = match app_resources::roots(&request.demand, self.minor) {
                    Ok(roots) => roots,
                    Err(message) => {
                        return (
                            vec![error(request.request_id, 0, "invalid", message)],
                            false,
                        );
                    }
                };
                let demand = demand(request.demand);
                match self.service.subscribe(demand, now) {
                    Ok(id) => {
                        if let Some(roots) = roots {
                            self.service.set_app_roots(roots);
                        }
                        self.subscriptions.insert(
                            id,
                            Subscription {
                                sequence: 0,
                                awaiting: None,
                                pending: None,
                                expires: now + LEASE,
                            },
                        );
                        let snapshot = self.service.latest().map(|s| {
                            mapping::snapshot(
                                s,
                                id,
                                self.epoch,
                                1,
                                true,
                                self.service.process_availability(now),
                                self.service.summary_availability(now),
                            )
                        });
                        let mut frames = vec![wrap(Payload::SubscribeAck(v1::SubscribeAck {
                            request_id: request.request_id,
                            subscription_id: id,
                        }))];
                        if let Some(snapshot) = snapshot {
                            if let Some(sub) = self.subscriptions.get_mut(&id) {
                                sub.sequence = 1;
                                sub.awaiting = Some((1, now));
                            }
                            frames.push(wrap(Payload::Snapshot(Box::new(snapshot))));
                        }
                        (frames, false)
                    }
                    Err(_) => (
                        vec![error(request.request_id, 0, "busy", "subscription limit")],
                        false,
                    ),
                }
            }
            Payload::UpdateSubscription(request) => {
                let roots = match app_resources::roots(&request.demand, self.minor) {
                    Ok(roots) => roots,
                    Err(message) => {
                        return (
                            vec![error(0, request.subscription_id, "invalid", message)],
                            false,
                        );
                    }
                };
                let requested_demand = demand(request.demand);
                match self
                    .service
                    .renew(request.subscription_id, requested_demand, now)
                {
                    Ok(()) => {
                        if let Some(roots) = roots {
                            self.service.set_app_roots(roots);
                        }
                        if let Some(sub) = self.subscriptions.get_mut(&request.subscription_id) {
                            sub.expires = now + LEASE;
                        }
                        (vec![], false)
                    }
                    Err(_) => (
                        vec![error(
                            0,
                            request.subscription_id,
                            "unknown-subscription",
                            "subscription expired",
                        )],
                        false,
                    ),
                }
            }
            Payload::Unsubscribe(request) => {
                self.subscriptions.remove(&request.subscription_id);
                let _ = self.service.unsubscribe(request.subscription_id);
                (vec![], false)
            }
            Payload::SnapshotAck(ack) => {
                let Some(sub) = self.subscriptions.get_mut(&ack.subscription_id) else {
                    return (
                        vec![error(
                            0,
                            ack.subscription_id,
                            "unknown-subscription",
                            "subscription expired",
                        )],
                        false,
                    );
                };
                if ack.epoch != self.epoch || sub.awaiting.map(|(seq, _)| seq) != Some(ack.sequence)
                {
                    return (
                        vec![error(
                            0,
                            ack.subscription_id,
                            "invalid-ack",
                            "ACK does not match pending snapshot",
                        )],
                        false,
                    );
                }
                sub.awaiting = None;
                if let Some(pending) = sub.pending.take() {
                    sub.awaiting = Some((pending.sequence, now));
                    return (vec![wrap(Payload::Snapshot(Box::new(pending)))], false);
                }
                (vec![], false)
            }
            Payload::ProcessQuery(request) => {
                (vec![query::query(&mut self.service, request, now)], false)
            }
            Payload::RetryCollection(request) => {
                self.service.retry_collection();
                self.epoch = self.epoch.wrapping_add(1);
                for sub in self.subscriptions.values_mut() {
                    sub.sequence = 0;
                    sub.awaiting = None;
                    sub.pending = None;
                }
                (
                    vec![
                        wrap(Payload::RetryAck(v1::RetryAck {
                            request_id: request.request_id,
                            epoch: self.epoch,
                        })),
                        collection_status::frame(&self.service, self.epoch, now),
                    ],
                    false,
                )
            }
            Payload::Shutdown(_) => (vec![], true),
            _ => (
                vec![error(0, 0, "invalid", "unexpected response frame")],
                false,
            ),
        }
    }

    pub(super) fn tick(&mut self, now: Instant) -> Vec<v1::Frame> {
        let mut frames = Vec::new();
        let mut remove = Vec::new();
        for (&id, sub) in &self.subscriptions {
            if sub.expires <= now
                || sub
                    .awaiting
                    .is_some_and(|(_, at)| now.duration_since(at) >= ACK_TIMEOUT)
            {
                remove.push(id);
                if sub.expires > now {
                    frames.push(error(
                        0,
                        id,
                        "ack-timeout",
                        "snapshot ACK deadline exceeded",
                    ));
                }
            }
        }
        for id in remove {
            self.subscriptions.remove(&id);
            let _ = self.service.unsubscribe(id);
        }
        if !self.subscriptions.is_empty()
            && self.service.summary_availability(now) == bigbud_system::model::Availability::Stale
        {
            self.epoch = self.epoch.wrapping_add(1);
            for sub in self.subscriptions.values_mut() {
                sub.sequence = 0;
                sub.awaiting = None;
                sub.pending = None;
            }
        }
        let previous_collection_state = self.service.collection_state();
        let sampled = self.service.tick(now).is_some();
        if self.service.collection_state() != previous_collection_state {
            frames.push(collection_status::frame(&self.service, self.epoch, now));
        }
        if sampled {
            let process_status = self.service.process_availability(now);
            let summary_status = self.service.summary_availability(now);
            let Some(sample) = self.service.latest() else {
                return frames;
            };
            for (&id, sub) in &mut self.subscriptions {
                sub.sequence = sub.sequence.wrapping_add(1);
                let snapshot = mapping::snapshot(
                    sample,
                    id,
                    self.epoch,
                    sub.sequence,
                    sub.sequence == 1,
                    process_status,
                    summary_status,
                );
                if sub.awaiting.is_some() {
                    sub.pending = Some(snapshot);
                } else {
                    sub.awaiting = Some((sub.sequence, now));
                    frames.push(wrap(v1::frame::Payload::Snapshot(Box::new(snapshot))));
                }
            }
        }
        frames
    }
}

fn demand(value: Option<v1::Demand>) -> Demand {
    value.map_or(Demand::default(), |v| Demand {
        processes: v.processes,
        disks: v.disks,
        sensors: v.sensors,
        app_resources: v.app_resources,
    })
}
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
