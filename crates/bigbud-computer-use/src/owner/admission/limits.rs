//! Frozen initial engineering bounds (plan M4 "Initial engineering bounds").
//! Proposed constants, not measured successes; qualification may only lower
//! them through reviewed evidence, never silently raise them in production.
use std::time::Duration;

pub const MAX_QUEUED_OPERATIONS: usize = 32;
pub const MAX_QUEUED_PER_CALLER: usize = 4;
pub const MAX_QUEUED_REQUEST_BYTES: usize = 1024 * 1024;
pub const MAX_ORDINARY_CONTROL_REQUESTS: usize = 8;
pub const CONTROL_FRAME_BYTES: u32 = 64 * 1024;
pub const DATA_FRAME_BYTES: u32 = 25 * 1024 * 1024;
pub const MAX_RETAINED_OUTCOMES: usize = 256;
pub const OUTCOME_RETENTION: Duration = Duration::from_secs(10 * 60);
pub const MAX_OUTCOME_METADATA_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DETAIL_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_DIAGNOSTIC_TAIL_BYTES: usize = 4 * 1024;
pub const MAX_CALLER_SESSIONS: usize = 32;
pub const MAX_TARGET_REFS_PER_CALLER: usize = 4;
/// D-run3-2: discovery selection handles sit outside the 4-target cap, are
/// short-lived and are promoted into a counted target reference on first use.
pub const MAX_SELECTION_HANDLES_PER_CALLER: usize = 256;
pub const SELECTION_HANDLE_TTL: Duration = Duration::from_secs(15);
pub const MAX_OBSERVATIONS: usize = 32;
pub const MAX_OBSERVATION_BYTES: usize = 64 * 1024 * 1024;
pub const OBSERVATION_TTL: Duration = Duration::from_secs(60);
pub const MAX_PROJECTED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_INGRESS_BYTES: usize = 32 * 1024 * 1024;
/// One mediated MCP `tools/call` request (10,000 UTF-16 text units fully
/// escaped is about 60 KiB).
pub const MAX_TOOL_CALL_FRAME_BYTES: usize = 128 * 1024;
pub const MAX_REQUEST_ID_CHARS: usize = 128;
pub const MAX_DECODED_IMAGE_BYTES: usize = 64 * 1024 * 1024;
pub const INCOMPLETE_FRAME_DEADLINE: Duration = Duration::from_secs(5);
pub const SESSION_IDLE_RECLAIM: Duration = Duration::from_secs(60);
pub const MAX_EPISODE_PARTICIPANTS: usize = 256;
pub const PARTICIPANT_RECONCILE: Duration = Duration::from_secs(2);
pub const PARTICIPATION_LEASE: Duration = Duration::from_secs(10);
pub const EPISODE_PREPARATION: Duration = Duration::from_secs(10);
pub const RENDERER_CHALLENGE_INTERVAL: Duration = Duration::from_millis(100);
pub const CONTROL_LEASE: Duration = Duration::from_millis(750);
pub const STOP_REVOCATION_TARGET: Duration = Duration::from_millis(250);
pub const STOP_UI_DEADLINE: Duration = Duration::from_secs(1);
pub const RETIREMENT_ESCALATION: Duration = Duration::from_millis(250);
pub const RETIREMENT_CONFIRMATION: Duration = Duration::from_secs(2);
pub const GRACEFUL_SHUTDOWN: Duration = Duration::from_secs(5);
pub const STARTUP_HANDSHAKE: Duration = Duration::from_secs(10);
pub const MAX_ACTION_TIMEOUT: Duration = Duration::from_secs(60 * 60);
pub const MIN_ACTION_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_ACTION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub const MIN_CHECK_IN: Duration = Duration::from_secs(60);
pub const MAX_CHECK_IN: Duration = Duration::from_secs(60 * 60);
pub const DEFAULT_CHECK_IN: Duration = Duration::from_secs(10 * 60);
