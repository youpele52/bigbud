//! Regenerates the shared additive v1.3 monitor fixture from the owning prost schema.
use bigbud_desktop_supervisor::monitor_v1 as v1;
use prost::Message;
use std::{error::Error, fmt::Write, path::Path};

fn hex(frame: v1::Frame) -> Result<String, Box<dyn Error>> {
    let bytes = frame.encode_to_vec();
    let mut result = String::new();
    for byte in (bytes.len() as u32).to_be_bytes().into_iter().chain(bytes) {
        write!(result, "{byte:02x}")?;
    }
    Ok(result)
}
fn metric(value: f64) -> Option<v1::Metric> {
    Some(v1::Metric {
        value,
        status: "ready".into(),
        sampled_at_ms: 1000,
    })
}
fn group(role: &str, processes: u32, cpu: f64, memory: f64) -> v1::AppGroup {
    v1::AppGroup {
        role: role.into(),
        process_count: processes,
        cpu_percent: metric(cpu),
        resident_bytes: metric(memory),
        read_bytes_per_second: metric(0.0),
        written_bytes_per_second: metric(2048.0),
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let subscribe = v1::Frame {
        payload: Some(v1::frame::Payload::Subscribe(v1::Subscribe {
            request_id: 1,
            demand: Some(v1::Demand {
                app_resources: true,
                app_roots: vec![v1::AppProcessRoot {
                    pid: 42,
                    identity: "owned:42".into(),
                    start_time_seconds: Some(123),
                    role: "desktop".into(),
                }],
                ..Default::default()
            }),
        })),
    };
    let app = v1::AppResources {
        generation: 1,
        sampled_at_ms: 1000,
        incomplete: false,
        core: Some(group("desktop", 3, 4.8, 1024.0)),
        inclusive: Some(group("tools", 4, 18.4, 2048.0)),
        groups: vec![
            group("desktop", 1, 3.1, 512.0),
            group("backend", 1, 1.4, 256.0),
            group("native", 1, 0.3, 256.0),
            group("tools", 1, 13.6, 1024.0),
        ],
    };
    let snapshot = v1::Frame {
        payload: Some(v1::frame::Payload::Snapshot(Box::new(v1::Snapshot {
            subscription_id: 1,
            epoch: 1,
            sequence: 1,
            baseline: true,
            sampled_at_ms: 1000,
            summary_status: "ready".into(),
            app_resources: Some(app),
            ..Default::default()
        }))),
    };
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/system-monitor/fixtures/v1.3.frames");
    std::fs::write(
        path,
        format!(
            "app_subscribe={}\napp_snapshot={}\n",
            hex(subscribe)?,
            hex(snapshot)?
        ),
    )?;
    Ok(())
}
