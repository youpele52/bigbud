//! In-process terminal host tests (plan §15 R5 exit criteria) on a fake clock.

#[path = "pty_lifecycle.tests.fixture.rs"]
mod fixture;
#[path = "pty_lifecycle.tests.launch.rs"]
mod launch;
#[path = "pty_lifecycle.tests.limit.rs"]
mod limit;
#[path = "pty_lifecycle.tests.load.rs"]
mod load;
#[path = "pty_lifecycle.tests.policy.rs"]
mod policy;
#[path = "pty_lifecycle.tests.retention.rs"]
mod retention;
#[path = "pty_lifecycle.tests.screen.rs"]
mod screen;
