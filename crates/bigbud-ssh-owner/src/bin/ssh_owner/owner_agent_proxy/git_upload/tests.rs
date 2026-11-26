use super::Recipe;

const ROOT: &str = "/tmp/bigbud-picker-linux-F1xture";

#[test]
fn startup_binds_one_opaque_repository_path() {
    let path = format!("{ROOT}/fixture's $(literal); repository");
    let recipe = Recipe::new(ROOT, &path).unwrap();
    assert!(recipe.matches_binding(&path));
    assert!(!recipe.matches_binding(&format!("{ROOT}/another.git")));
    assert!(recipe.command().contains("fixture'\\''s $(literal);"));
}

#[test]
fn rejects_paths_outside_the_exact_direct_child_fixture_class() {
    for root in [
        "/tmp",
        "/tmp/bigbud-picker-linux-",
        "/tmp/bigbud-picker-linux-other/root",
        "/tmp/bigbud-picker-linux-with-dash",
        "/tmp//bigbud-picker-linux-F1xture",
        "/tmp/bigbud-picker-linux-F1xture/",
        &format!("/tmp/bigbud-picker-linux-{}", "x".repeat(65)),
    ] {
        assert!(Recipe::new(root, &format!("{root}/fixture.git")).is_err());
    }
    for path in [
        ROOT.to_owned(),
        format!("{ROOT}more/fixture.git"),
        format!("{ROOT}/"),
        format!("{ROOT}/."),
        format!("{ROOT}/.."),
        format!("{ROOT}/sub/fixture.git"),
        format!("{ROOT}//fixture.git"),
        format!("{ROOT}/fixture.git/"),
        format!("{ROOT}/nul\0.git"),
        format!("{ROOT}/line\n.git"),
        format!("{ROOT}/{}", "x".repeat(256)),
        "relative.git".to_owned(),
    ] {
        assert!(Recipe::new(ROOT, &path).is_err(), "{path:?}");
    }
}

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod linux;
