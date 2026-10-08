use bigbud_desktop_supervisor::monitor_v1 as v1;
use prost::Message;
use std::{error::Error, io};

#[test]
fn additive_app_fixtures_match_the_rust_schema() -> Result<(), Box<dyn Error>> {
    let fixture = include_str!("../../../protocol/system-monitor/fixtures/v1.3.frames");
    for line in fixture.lines() {
        let (name, hex) = line
            .split_once('=')
            .ok_or_else(|| io::Error::other("fixture missing separator"))?;
        let bytes = hex
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| -> Result<u8, Box<dyn Error>> {
                Ok(u8::from_str_radix(std::str::from_utf8(pair)?, 16)?)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let frame = v1::Frame::decode(
            bytes
                .get(4..)
                .ok_or_else(|| io::Error::other("fixture missing prefix"))?,
        )?;
        match (name, &frame.payload) {
            ("app_subscribe", Some(v1::frame::Payload::Subscribe(request))) => {
                let demand = request
                    .demand
                    .as_ref()
                    .ok_or_else(|| io::Error::other("missing demand"))?;
                if !demand.app_resources || demand.app_roots.len() != 1 {
                    return Err(io::Error::other("invalid app demand fixture").into());
                }
            }
            ("app_snapshot", Some(v1::frame::Payload::Snapshot(snapshot))) => {
                let app = snapshot
                    .app_resources
                    .as_ref()
                    .ok_or_else(|| io::Error::other("missing app"))?;
                if app.groups.len() != 4
                    || app.core.as_ref().map(|g| g.process_count) != Some(3)
                    || app.inclusive.as_ref().map(|g| g.process_count) != Some(4)
                {
                    return Err(io::Error::other("invalid app summary fixture").into());
                }
            }
            _ => return Err(io::Error::other("unexpected fixture payload").into()),
        }
        if frame.encode_to_vec()
            != bytes
                .get(4..)
                .ok_or_else(|| io::Error::other("fixture missing payload"))?
        {
            return Err(io::Error::other("fixture reencoding changed bytes").into());
        }
    }
    Ok(())
}
