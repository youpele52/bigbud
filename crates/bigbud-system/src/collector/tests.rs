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
