use super::{JournalError, MAX_RECORD_BYTES, SafetyRecord};
use crate::{
    guard::record::{EpisodeNotice, NoticeState, PolicyBinding},
    worker::ExecutionRoot,
};
use std::num::NonZeroU32;

pub(super) fn encode(record: &SafetyRecord) -> Result<Vec<u8>, JournalError> {
    if !record.valid() {
        return Err(JournalError::Invalid);
    }
    let mut text = format!(
        "bigbud-computer-use-safety\t1\n{}\t{}\t{}\t{}\t{}\n",
        record.pause_epoch,
        u8::from(record.latched),
        record.reason,
        u8::from(record.armed),
        u8::from(record.input_uncertain)
    );
    match &record.binding {
        None => text.push_str("-\n"),
        Some(v) => text.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\n",
            v.authority,
            v.controller_installation,
            v.profile_generation,
            v.revision,
            v.digest,
            v.migration_binding
        )),
    }
    match &record.notice {
        None => text.push_str("-\n"),
        Some(v) => text.push_str(&format!(
            "{}\t{}\t{}\n",
            v.episode,
            v.notice,
            v.state.text()
        )),
    }
    for root in &record.roots {
        text.push_str(&format!(
            "{}\t{}\t{}\n",
            root.pid, root.creation_identity, root.generation
        ));
    }
    if text.len() > MAX_RECORD_BYTES {
        return Err(JournalError::Invalid);
    }
    Ok(text.into_bytes())
}
fn decimal<T: std::str::FromStr>(text: &str) -> Result<T, JournalError> {
    if text.is_empty()
        || !text.bytes().all(|byte| byte.is_ascii_digit())
        || (text != "0" && text.starts_with('0'))
    {
        return Err(JournalError::Invalid);
    }
    text.parse().map_err(|_| JournalError::Invalid)
}
fn boolean(text: &str) -> Result<bool, JournalError> {
    match text {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(JournalError::Invalid),
    }
}
fn next<'a>(lines: &mut impl Iterator<Item = &'a str>) -> Result<&'a str, JournalError> {
    lines.next().ok_or(JournalError::Invalid)
}

pub(super) fn decode(bytes: &[u8]) -> Result<SafetyRecord, JournalError> {
    if bytes.len() > MAX_RECORD_BYTES || !bytes.ends_with(b"\n") {
        return Err(JournalError::Invalid);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| JournalError::Invalid)?;
    let mut lines = text.lines();
    if next(&mut lines)? != "bigbud-computer-use-safety\t1" {
        return Err(JournalError::Invalid);
    }
    let header: Vec<_> = next(&mut lines)?.split('\t').collect();
    let [epoch, latch, reason, armed, uncertain] = header.as_slice() else {
        return Err(JournalError::Invalid);
    };
    let binding = match next(&mut lines)? {
        "-" => None,
        value => {
            let fields: Vec<_> = value.split('\t').collect();
            let [
                authority,
                installation,
                profile,
                revision,
                digest,
                migration,
            ] = fields.as_slice()
            else {
                return Err(JournalError::Invalid);
            };
            Some(PolicyBinding {
                authority: (*authority).into(),
                controller_installation: (*installation).into(),
                profile_generation: (*profile).into(),
                revision: (*revision).into(),
                digest: (*digest).into(),
                migration_binding: (*migration).into(),
            })
        }
    };
    let notice = match next(&mut lines)? {
        "-" => None,
        value => {
            let fields: Vec<_> = value.split('\t').collect();
            let [episode, notice, state] = fields.as_slice() else {
                return Err(JournalError::Invalid);
            };
            Some(EpisodeNotice {
                episode: (*episode).into(),
                notice: (*notice).into(),
                state: NoticeState::parse(state).ok_or(JournalError::Invalid)?,
            })
        }
    };
    let mut roots = Vec::new();
    for line in lines {
        if roots.len() >= crate::guard::record::MAX_ROOTS {
            return Err(JournalError::Invalid);
        }
        let fields: Vec<_> = line.split('\t').collect();
        let [pid, creation_identity, generation] = fields.as_slice() else {
            return Err(JournalError::Invalid);
        };
        roots.push(ExecutionRoot {
            pid: NonZeroU32::new(decimal(pid)?).ok_or(JournalError::Invalid)?,
            creation_identity: (*creation_identity).into(),
            generation: (*generation).into(),
        });
    }
    let record = SafetyRecord {
        pause_epoch: decimal(epoch)?,
        latched: boolean(latch)?,
        reason: (*reason).into(),
        armed: boolean(armed)?,
        input_uncertain: boolean(uncertain)?,
        binding,
        notice,
        roots,
    };
    if !record.valid() || encode(&record)? != bytes {
        return Err(JournalError::Invalid);
    }
    Ok(record)
}
