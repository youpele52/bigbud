//! W2 T-files production guarded save: one guarded-write lane per target.
//!
//! A production owner has no fixture root, so the lane lives in the target's
//! `Lanes`, is created on first use and is bound to that target's current
//! generation; a generation change drops any draft. Finalized operation ids are
//! kept per target and never evicted, so an id is applied at most once by this
//! owner. The server's durable journal claims the intent before APPLY and is
//! the replay authority across owner death.

use super::{ErrorCode, GuardedWrite, Owner, Stage};
use std::collections::HashSet;

impl GuardedWrite {
    pub(super) fn for_production(generation: crate::Token) -> Self {
        Self {
            stage: Stage::new_production(generation),
            finalized: HashSet::new(),
            apply_proof: true,
        }
    }
}

impl Owner {
    /// The guarded-write lane serving this request: the fixture's owner-wide
    /// lane, or the current production target's own lane.
    pub(super) fn guarded_lane(&mut self) -> Result<&mut GuardedWrite, ErrorCode> {
        if !self.production {
            return self
                .guarded_write
                .as_mut()
                .ok_or(ErrorCode::OperationDenied);
        }
        let generation = self.generation;
        let lane = self
            .lanes
            .guarded_write
            .get_or_insert_with(|| GuardedWrite::for_production(generation));
        if lane.stage.generation() != generation {
            lane.reset_attachment(generation);
        }
        Ok(lane)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Binding, Stage};
    use std::time::Instant;

    fn binding(generation: crate::Token, root: &str) -> Binding {
        Binding {
            generation,
            operation_id: "a".repeat(32),
            root: root.into(),
            path: "notes.txt".into(),
            expected_sha256: [1; 32],
            attempted_sha256: [2; 32],
            body_bytes: 3,
        }
    }

    #[test]
    fn a_production_stage_admits_each_save_root_but_not_a_foreign_generation() {
        let now = Instant::now();
        let mut stage = Stage::new_production([7; 32]);
        assert!(
            stage
                .begin(&binding([7; 32], "/home/dev/project"), [0; 32], now)
                .is_ok()
        );
        stage.reset_attachment([7; 32]);
        for root in ["/", "relative", "/a/../b", "/a//b"] {
            assert!(
                stage.begin(&binding([7; 32], root), [0; 32], now).is_err(),
                "{root}"
            );
        }
        assert!(
            stage
                .begin(&binding([8; 32], "/srv/work"), [0; 32], now)
                .is_err()
        );
        stage.reset_attachment([8; 32]);
        assert_eq!(stage.generation(), [8; 32]);
        assert!(
            stage
                .begin(&binding([8; 32], "/srv/work"), [0; 32], now)
                .is_ok()
        );
    }
}
