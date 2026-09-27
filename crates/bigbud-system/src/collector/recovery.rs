use super::*;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum CollectionError {
    #[error("CPU observation unavailable")]
    MissingCpu,
    #[error("memory observation unavailable")]
    MissingMemory,
}

impl Collector {
    /// Required summary fields must be valid before publication.
    pub fn sample_checked(
        &mut self,
        demand: Demand,
        now: Instant,
    ) -> Result<(Snapshot, Option<Inventory>), CollectionError> {
        let result = self.sample(demand, now);
        validate(self.system.cpus().len(), self.system.total_memory())?;
        Ok(result)
    }
}

fn validate(cpu_count: usize, total_memory: u64) -> Result<(), CollectionError> {
    if cpu_count == 0 {
        return Err(CollectionError::MissingCpu);
    }
    if total_memory == 0 {
        return Err(CollectionError::MissingMemory);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn required_baseline_validation_is_typed() {
        assert_eq!(validate(0, 1024), Err(CollectionError::MissingCpu));
        assert_eq!(validate(4, 0), Err(CollectionError::MissingMemory));
        assert_eq!(validate(4, 1024), Ok(()));
    }
}
