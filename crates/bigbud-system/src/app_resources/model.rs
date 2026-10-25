use crate::model::Field;
use std::time::SystemTime;

pub const MAX_ROOTS: usize = 128;
pub const MAX_PROCESSES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Desktop,
    Backend,
    Native,
    Tools,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Backend => "backend",
            Self::Native => "native",
            Self::Tools => "tools",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Root {
    pub pid: u32,
    pub identity: String,
    pub start_time_seconds: Option<u64>,
    pub role: Role,
}

#[derive(Clone, Debug)]
pub struct Group {
    pub role: Role,
    pub process_count: u32,
    pub cpu_percent: Field<f64>,
    pub resident_bytes: Field<u64>,
    pub read_bytes_per_second: Field<f64>,
    pub written_bytes_per_second: Field<f64>,
}

#[derive(Clone, Debug)]
pub struct AppResources {
    pub generation: u64,
    pub sampled_at: SystemTime,
    pub incomplete: bool,
    pub core: Group,
    pub inclusive: Group,
    pub groups: Vec<Group>,
}
