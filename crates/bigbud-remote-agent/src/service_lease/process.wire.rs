//! Bounded private bootstrap. Never journal, Debug or forward this frame.
use super::{Error, Launch, Result, SecretEnvironment};
use std::io::Read;
use std::path::PathBuf;
const MAXIMUM: usize = 128 * 1024;
fn field(output: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    if value.len() > 65536 || output.len() + value.len() + 4 > MAXIMUM {
        return Err(Error::Invalid);
    }
    output.extend_from_slice(&(value.len() as u32).to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}
pub(super) fn encode(launch: &Launch, digest: &[u8; 32]) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    field(&mut output, b"bigbud-service-lease=1")?;
    field(&mut output, digest)?;
    field(
        &mut output,
        launch.executable.to_str().ok_or(Error::Invalid)?.as_bytes(),
    )?;
    output.extend_from_slice(&(launch.args.len() as u32).to_be_bytes());
    for argument in &launch.args {
        field(&mut output, argument.as_bytes())?;
    }
    output.extend_from_slice(&(launch.environment.0.len() as u32).to_be_bytes());
    for (name, value) in &launch.environment.0 {
        field(&mut output, name.as_bytes())?;
        field(&mut output, value.as_bytes())?;
    }
    field(
        &mut output,
        launch
            .guard
            .as_ref()
            .map(super::super::Guard::bytes)
            .unwrap_or(&[]),
    )?;
    if let Some(resource) = &launch.assets {
        field(
            &mut output,
            resource.state.to_str().ok_or(Error::Invalid)?.as_bytes(),
        )?;
        field(&mut output, resource.generation.as_bytes())?;
        field(&mut output, &resource.size.to_be_bytes())?;
        field(&mut output, &resource.sha256)?;
        field(&mut output, resource.argument.as_bytes())?;
    } else {
        field(&mut output, &[])?;
    }
    if output.len() > MAXIMUM {
        return Err(Error::Invalid);
    }
    Ok(output)
}
fn number(input: &mut &[u8]) -> Result<usize> {
    let bytes = input.get(..4).ok_or(Error::Invalid)?;
    let count = u32::from_be_bytes(bytes.try_into().map_err(|_| Error::Invalid)?) as usize;
    *input = input.get(4..).ok_or(Error::Invalid)?;
    Ok(count)
}
fn take(input: &mut &[u8]) -> Result<Vec<u8>> {
    let count = number(input)?;
    if count > 65536 {
        return Err(Error::Invalid);
    }
    let value = input.get(..count).ok_or(Error::Invalid)?.to_vec();
    *input = input.get(count..).ok_or(Error::Invalid)?;
    Ok(value)
}
fn string(input: &mut &[u8]) -> Result<String> {
    String::from_utf8(take(input)?).map_err(|_| Error::Invalid)
}
pub(super) fn read(input: &mut impl Read) -> Result<(Launch, [u8; 32])> {
    let mut prefix = [0; 4];
    input.read_exact(&mut prefix)?;
    let count = u32::from_be_bytes(prefix) as usize;
    if count > MAXIMUM {
        return Err(Error::Invalid);
    }
    let mut frame = vec![0; count];
    input.read_exact(&mut frame)?;
    let mut data = frame.as_slice();
    if take(&mut data)? != b"bigbud-service-lease=1" {
        return Err(Error::Invalid);
    }
    let digest = take(&mut data)?.try_into().map_err(|_| Error::Invalid)?;
    let executable = PathBuf::from(string(&mut data)?);
    let count = number(&mut data)?;
    if count > 128 {
        return Err(Error::Invalid);
    }
    let args = (0..count)
        .map(|_| string(&mut data))
        .collect::<Result<Vec<_>>>()?;
    let count = number(&mut data)?;
    if count > 64 {
        return Err(Error::Invalid);
    }
    let environment = (0..count)
        .map(|_| Ok((string(&mut data)?, string(&mut data)?)))
        .collect::<Result<Vec<_>>>()?;
    let guard = take(&mut data)?;
    let guard = if guard.is_empty() {
        None
    } else {
        Some(super::super::Guard::parse(&guard)?)
    };
    let state = string(&mut data)?;
    let assets = if state.is_empty() {
        None
    } else {
        let generation = string(&mut data)?;
        let size = u64::from_be_bytes(take(&mut data)?.try_into().map_err(|_| Error::Invalid)?);
        let sha256 = take(&mut data)?.try_into().map_err(|_| Error::Invalid)?;
        let argument = string(&mut data)?;
        Some(super::super::AssetsResource::new(
            state.into(),
            generation,
            size,
            sha256,
            argument,
        )?)
    };
    if !data.is_empty() {
        return Err(Error::Invalid);
    }
    Ok((
        Launch {
            executable,
            args,
            environment: SecretEnvironment(environment),
            guard,
            assets,
        },
        digest,
    ))
}
/// Private same-executable monitor reply: tag, child PID, start ticks, listener inode, port.
pub(super) const READY_FRAME: usize = 23;
pub(super) type Original = Option<(super::readiness::Proof, u64)>;
pub(super) fn ready(pid: u32, original: Original) -> [u8; READY_FRAME] {
    let mut frame = [0; READY_FRAME];
    frame[0] = b'R';
    frame[1..5].copy_from_slice(&pid.to_be_bytes());
    if let Some((proof, started)) = original {
        frame[5..13].copy_from_slice(&started.to_be_bytes());
        frame[13..21].copy_from_slice(&proof.inode.to_be_bytes());
        frame[21..23].copy_from_slice(&proof.address.port().to_be_bytes());
    }
    frame
}
/// A readiness launch must prove every field; a plain launch carries none.
pub(super) fn parse_ready(frame: &[u8; READY_FRAME], readiness: bool) -> Result<(u32, Original)> {
    let number = |range: std::ops::Range<usize>| frame.get(range).ok_or(Error::Invalid);
    let pid = u32::from_be_bytes(number(1..5)?.try_into().map_err(|_| Error::Invalid)?);
    let started = u64::from_be_bytes(number(5..13)?.try_into().map_err(|_| Error::Invalid)?);
    let inode = u64::from_be_bytes(number(13..21)?.try_into().map_err(|_| Error::Invalid)?);
    let port = u16::from_be_bytes(number(21..23)?.try_into().map_err(|_| Error::Invalid)?);
    if frame[0] != b'R' || pid <= 1 {
        return Err(Error::Uncertain);
    }
    if !readiness {
        return if (started, inode, port) == (0, 0, 0) {
            Ok((pid, None))
        } else {
            Err(Error::Uncertain)
        };
    }
    if started == 0 || inode == 0 || port == 0 {
        return Err(Error::Uncertain);
    }
    let address = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
    Ok((
        pid,
        Some((super::readiness::Proof { address, inode }, started)),
    ))
}
#[cfg(test)]
#[path = "process.wire.tests.rs"]
mod tests;
