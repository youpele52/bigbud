//! Reject malformed private requests before account filesystem/manager IO.
use super::{Error, Result};
use bigbud_protocol::{service_lease::v1 as lease, v1::frame::Payload};
fn binding(value: Option<&lease::Binding>) -> Result<()> {
    let value = value.ok_or(Error::Invalid)?;
    if value.authority.len() != 32
        || value.installation.len() != 71
        || value.native_epoch.len() > 128
        || value.nonce.len() > 128
        || [
            &value.publication_sha256,
            &value.executable_sha256,
            &value.assets_sha256,
            &value.configuration_sha256,
            &value.guard_sha256,
        ]
        .iter()
        .any(|bytes| bytes.len() != 32)
    {
        return Err(Error::Invalid);
    }
    super::protocol::binding(Some(value.clone()))?;
    Ok(())
}
fn common(id: &str, value: Option<&lease::Binding>, capability: &[u8]) -> Result<()> {
    if !super::protocol::valid_request_id(id) || !(32..=64).contains(&capability.len()) {
        return Err(Error::Invalid);
    }
    binding(value)
}
pub(super) fn request(payload: &Payload) -> Result<Option<super::Guard>> {
    match payload {
        Payload::ServiceLeaseStartRequest(value) => {
            common(&value.request_id, value.binding.as_ref(), &value.capability)?;
            if value.executable.len() > 4096
                || value.args.len() > 128
                || value.environment.len() > 64
                || value.assets_generation.len() != 39
                || value.assets_receipt_size == 0
                || value.assets_receipt_size > 8 * 1024 * 1024
                || value.assets_receipt_sha256.len() != 32
                || value.assets_argument.len() > 64
                || value.guard.is_empty()
                || value.guard.len() > 16 * 1024
            {
                return Err(Error::Invalid);
            }
            let mut size = value.executable.len();
            for argument in &value.args {
                size = size.checked_add(argument.len()).ok_or(Error::Invalid)?;
                if size > 65536 || argument.contains('\0') {
                    return Err(Error::Invalid);
                }
            }
            let mut names = std::collections::HashSet::new();
            for env in &value.environment {
                size = size
                    .checked_add(env.name.len())
                    .and_then(|n| n.checked_add(env.value.len()))
                    .ok_or(Error::Invalid)?;
                if size > 96 * 1024
                    || env.name.is_empty()
                    || env.name.len() > 128
                    || env.name.contains(['=', '\0'])
                    || env.value.contains('\0')
                    || !names.insert(&env.name)
                {
                    return Err(Error::Invalid);
                }
            }
            super::AssetsResource::validate_reference(
                &value.assets_generation,
                value.assets_receipt_size,
                &value.assets_receipt_sha256,
                &value.assets_argument,
            )?;
            Ok(Some(super::Guard::parse(&value.guard)?))
        }
        Payload::ServiceLeaseStatusRequest(value)
            if value.binding.is_none() && value.capability.is_empty() =>
        {
            if !super::protocol::valid_request_id(&value.request_id) {
                return Err(Error::Invalid);
            }
            Ok(None)
        }
        Payload::ServiceLeaseStatusRequest(value) | Payload::ServiceLeaseResumeRequest(value) => {
            common(&value.request_id, value.binding.as_ref(), &value.capability).map(|()| None)
        }
        Payload::ServiceLeaseControlRequest(value) => {
            common(&value.request_id, value.binding.as_ref(), &value.capability)?;
            if !matches!(
                value.action.as_str(),
                "detach" | "stop" | "cancel-pending" | "stop-original"
            ) || value.generation > 9_007_199_254_740_991
                || matches!(value.action.as_str(), "cancel-pending" | "stop-original")
                    != (value.generation == 0)
            {
                return Err(Error::Invalid);
            }
            Ok(None)
        }
        _ => Err(Error::Invalid),
    }
}
