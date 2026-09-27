use std::{
    error::Error,
    io::{self, Read, Write},
    process::{Command, Stdio},
};

use bigbud_desktop_supervisor::monitor_v1 as v1;
use prost::Message;

fn send(writer: &mut impl Write, frame: v1::Frame) -> io::Result<()> {
    let bytes = frame.encode_to_vec();
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}
fn receive(reader: &mut impl Read) -> Result<v1::Frame, Box<dyn Error>> {
    let mut length = [0; 4];
    reader.read_exact(&mut length)?;
    let size = u32::from_be_bytes(length) as usize;
    if size > 128 * 1024 {
        return Err(io::Error::other("oversized response").into());
    }
    let mut payload = vec![0; size];
    reader.read_exact(&mut payload)?;
    Ok(v1::Frame::decode(payload.as_slice())?)
}

#[test]
fn monitor_mode_handshakes_and_shuts_down_without_touching_delivery_mode()
-> Result<(), Box<dyn Error>> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-desktop-supervisor"))
        .arg("--system-monitor")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("missing stdin"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing stdout"))?;
    send(
        &mut stdin,
        v1::Frame {
            payload: Some(v1::frame::Payload::Hello(v1::Hello { major: 1, minor: 0 })),
        },
    )?;
    let frame = receive(&mut stdout)?;
    if !matches!(frame.payload, Some(v1::frame::Payload::HelloAck(ack)) if ack.major == 1 && ack.maximum_frame_bytes == 128 * 1024)
    {
        return Err(io::Error::other("invalid monitor handshake").into());
    }
    if !matches!(receive(&mut stdout)?.payload, Some(v1::frame::Payload::CollectionStatus(status)) if status.phase == v1::CollectionPhase::Healthy as i32)
    {
        return Err(io::Error::other("missing initial collection status").into());
    }
    send(
        &mut stdin,
        v1::Frame {
            payload: Some(v1::frame::Payload::Shutdown(v1::Shutdown {})),
        },
    )?;
    drop(stdin);
    if !child.wait()?.success() {
        return Err(io::Error::other("monitor did not stop cleanly").into());
    }
    Ok(())
}

#[test]
fn monitor_mode_rejects_oversized_frames_before_allocation() -> Result<(), Box<dyn Error>> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-desktop-supervisor"))
        .arg("--system-monitor")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("missing stdin"))?;
    stdin.write_all(&(128_u32 * 1024 + 1).to_be_bytes())?;
    drop(stdin);
    if child.wait()?.success() {
        return Err(io::Error::other("monitor accepted oversized frame").into());
    }
    Ok(())
}

#[test]
fn monitor_mode_streams_a_snapshot_and_answers_process_query() -> Result<(), Box<dyn Error>> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-desktop-supervisor"))
        .arg("--system-monitor")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("missing stdin"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing stdout"))?;
    send(
        &mut stdin,
        v1::Frame {
            payload: Some(v1::frame::Payload::Hello(v1::Hello { major: 1, minor: 0 })),
        },
    )?;
    if !matches!(
        receive(&mut stdout)?.payload,
        Some(v1::frame::Payload::HelloAck(_))
    ) {
        return Err(io::Error::other("missing handshake").into());
    }
    if !matches!(receive(&mut stdout)?.payload, Some(v1::frame::Payload::CollectionStatus(status)) if status.phase == v1::CollectionPhase::Healthy as i32)
    {
        return Err(io::Error::other("missing initial collection status").into());
    }
    send(
        &mut stdin,
        v1::Frame {
            payload: Some(v1::frame::Payload::Subscribe(v1::Subscribe {
                request_id: 1,
                demand: Some(v1::Demand {
                    processes: true,
                    disks: true,
                    sensors: false,
                }),
            })),
        },
    )?;
    if !matches!(receive(&mut stdout)?.payload, Some(v1::frame::Payload::SubscribeAck(reply)) if reply.subscription_id == 1)
    {
        return Err(io::Error::other("missing subscription response").into());
    }
    let snapshot = match receive(&mut stdout)?.payload {
        Some(v1::frame::Payload::Snapshot(snapshot)) => snapshot,
        _ => return Err(io::Error::other("missing snapshot").into()),
    };
    if snapshot.subscription_id != 1
        || snapshot.hostname.len() > 256
        || snapshot.cpu_percent.is_none()
        || snapshot.memory_available_bytes.is_none()
        || snapshot.swap_free_bytes.is_none()
        || snapshot.boot_time_seconds.is_none()
        || snapshot.cpu_frequency_mhz.is_none()
        || snapshot.load_average_one.is_none()
    {
        return Err(io::Error::other("invalid snapshot").into());
    }
    send(
        &mut stdin,
        v1::Frame {
            payload: Some(v1::frame::Payload::ProcessQuery(v1::ProcessQuery {
                request_id: 2,
                name: String::new(),
                pid: None,
                status: String::new(),
                sort: "cpu".into(),
                descending: true,
                limit: 10,
                cursor_generation: 0,
                cursor_digest: 0,
                cursor_offset: 0,
            })),
        },
    )?;
    if !matches!(receive(&mut stdout)?.payload, Some(v1::frame::Payload::ProcessPage(page)) if page.request_id == 2 && page.rows.len() <= 10)
    {
        return Err(io::Error::other("missing process page").into());
    }
    send(
        &mut stdin,
        v1::Frame {
            payload: Some(v1::frame::Payload::Shutdown(v1::Shutdown {})),
        },
    )?;
    drop(stdin);
    if !child.wait()?.success() {
        return Err(io::Error::other("monitor did not stop cleanly").into());
    }
    Ok(())
}
