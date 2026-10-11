#![cfg(windows)]
use bigbud_remote_agent::inspect_local::metadata;
use std::{fs, io};
#[path = "support/windows.fixture.rs"]
mod file_fixture;
#[path = "support/metadata.fixture.rs"]
mod fixture;
// Compile the parser's own regressions without unrelated Unix-only library test modules.
#[allow(dead_code)]
#[path = "../src/inspect_local/windows.metadata.members.rs"]
mod membership_validation;

#[test]
fn metadata_fixture_child() -> io::Result<()> {
    if let Some(root) = std::env::var_os("BIGBUD_METADATA_CHILD") {
        fixture::child(std::path::Path::new(&root))?;
    }
    Ok(())
}

#[test]
fn class47_binds_same_measured_file_not_replacement_path() -> io::Result<()> {
    let f = fixture::Fixture::start(1)?;
    let original = metadata::membership(f.child.id(), &f.path(""))?;
    assert!(
        original.0,
        "target must be in independently opened file's class47 inventory"
    );
    fs::rename(f.path(""), f.path(".retained"))?;
    fs::copy(f.path(".retained"), f.path(""))?;
    // Elevated runners create the replacement as Administrators-owned; normalize only our fixture.
    file_fixture::own_fixture(&f.root)?;
    let replacement = metadata::membership(f.child.id(), &f.path(""))?;
    assert!(
        !replacement.0,
        "old file membership must not transfer to replacement pathname"
    );
    assert_ne!(original.1, replacement.1);
    assert_eq!(
        metadata::membership(f.child.id(), &f.path(".retained"))?,
        original
    );
    assert!(metadata::probe(f.child.id()).is_err());
    Ok(())
}

#[test]
fn mapped_extensionless_identity_survives_restart_but_not_replacement() -> io::Result<()> {
    let mut f = fixture::Fixture::start(1)?;
    let before = metadata::probe(f.child.id())?;
    f.restart()?;
    let restart = metadata::probe(f.child.id())?;
    assert_eq!(before.identity, restart.identity);
    assert_ne!(before.birth, restart.birth);
    f.stop()?;
    fs::rename(f.path(""), f.path(".old"))?;
    fs::copy(f.path(".old"), f.path(""))?;
    file_fixture::own_fixture(&f.root)?;
    f.restart()?;
    assert_ne!(before.identity, metadata::probe(f.child.id())?.identity);
    Ok(())
}

#[test]
fn ambiguous_and_invalidated_mapping_inventory_never_yields_survivor() -> io::Result<()> {
    let two = fixture::Fixture::start(2)?;
    assert!(metadata::probe(two.child.id()).is_err());
    let mut one = fixture::Fixture::start(1)?;
    let mut hook_reached = false;
    let result = metadata::probe_with(one.child.id(), || {
        hook_reached = true;
        one.command("unmap")
    });
    assert!(
        hook_reached,
        "initial probe proof must work before race injection"
    );
    assert!(result.is_err());
    one.restart()?;
    let result = metadata::probe_with(one.child.id(), || one.stop());
    assert!(
        result.is_err(),
        "retained process exit must invalidate membership"
    );
    Ok(())
}
