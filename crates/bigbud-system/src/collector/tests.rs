use super::*;
#[test]
fn first_sample_marks_rates_warming() {
    let mut collector = Collector::new();
    let (sample, _) = collector.sample(Demand::default(), Instant::now());
    assert_eq!(sample.cpu.total_percent.status, Availability::Warming);
    assert_eq!(
        sample.network.received_bytes_per_second.status,
        Availability::Warming
    );
}
#[test]
fn disk_observation_is_retained_between_refreshes() {
    let mut collector = Collector::new();
    let at = Instant::now();
    let demand = Demand {
        disks: true,
        ..Demand::default()
    };
    let (first, _) = collector.sample(demand, at);
    let (second, _) = collector.sample(demand, at + Duration::from_secs(1));
    assert!(first.disks.is_some());
    assert!(second.disks.is_some());
}

#[test]
fn app_only_process_state_is_released_when_host_only_demand_remains() {
    let mut collector = Collector::new();
    assert!(collector.set_app_roots(vec![crate::app_resources::Root {
        pid: std::process::id(),
        identity: "test-owner".into(),
        start_time_seconds: None,
        role: crate::app_resources::Role::Desktop,
    }]));
    let _sample = collector.sample(
        Demand {
            app_resources: true,
            ..Default::default()
        },
        Instant::now(),
    );
    assert!(!collector.system.processes().is_empty());
    collector.release_app_resources();
    collector.release_processes();
    assert!(collector.system.processes().is_empty());
    assert!(collector.app.latest().is_none());
}
