//! Explicit-only real-process tests, never desktop/Driver qualification.
//! Run --test dummy_lifecycle physical:: -- --ignored --test-threads=1
//! --skip physical::dummy_entry. test=false excludes this target by default.
//! Reuse owning modules verbatim in a test crate so private cfg(test) teardown /
//! bootstrap seams cannot become production public authority or features.
#![cfg(target_os = "macos")]
#[path = "../src/guard/mod.rs"]
pub mod guard;
#[path = "../src/native_fs/mod.rs"]
mod native_fs;
#[path = "../src/owner/mod.rs"]
pub mod owner;
#[path = "../src/sha256.rs"]
mod sha256;
#[path = "../src/worker/mod.rs"]
pub mod worker;
pub use bigbud_computer_use::Role;
#[path = "physical/cases.rs"]
mod physical;
