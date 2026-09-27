use crate::model::{Availability, Field, LinkState};
use std::time::SystemTime;
use sysinfo::InterfaceOperationalState;

pub(super) fn link_state(value: InterfaceOperationalState, at: SystemTime) -> Field<LinkState> {
    let normalized = match value {
        InterfaceOperationalState::Up => LinkState::Up,
        InterfaceOperationalState::Down => LinkState::Down,
        InterfaceOperationalState::Testing => LinkState::Testing,
        InterfaceOperationalState::Unknown => LinkState::Unknown,
        InterfaceOperationalState::Dormant => LinkState::Dormant,
        InterfaceOperationalState::NotPresent => LinkState::NotPresent,
        InterfaceOperationalState::LowerLayerDown => LinkState::LowerLayerDown,
        _ => return Field::absent(Availability::Unavailable, at),
    };
    Field::ready(normalized, at)
}

pub(super) fn mtu(value: u64, at: SystemTime) -> Field<u64> {
    if value == 0 {
        Field::absent(Availability::Unavailable, at)
    } else {
        Field::ready(value, at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_state_and_mtu_have_explicit_availability() {
        let at = SystemTime::UNIX_EPOCH;
        assert_eq!(
            link_state(InterfaceOperationalState::Up, at).value,
            Some(LinkState::Up)
        );
        assert_eq!(LinkState::LowerLayerDown.as_str(), "lower-layer-down");
        assert_eq!(
            link_state(InterfaceOperationalState::Unknown, at).value,
            Some(LinkState::Unknown)
        );
        assert_eq!(mtu(0, at).status, Availability::Unavailable);
        assert_eq!(mtu(1500, at).value, Some(1500));
    }
}
