use super::IgnoreUnknown;

#[test]
fn ignores_only_listed_keywords_openssh_does_not_know() {
    let mut ignore = IgnoreUnknown::default();
    assert!(!ignore.ignores("FancyOption yes"));
    ignore.set("Fancy*,AddKeys*");
    ignore.set("Other");
    assert!(ignore.ignores("FancyOption yes"));
    assert!(ignore.ignores("  fancyother=1"));
    // Known to OpenSSH: applied by OpenSSH even when listed, so never ignored.
    assert!(!ignore.ignores("AddKeysToAgent yes"));
    // Only the first IgnoreUnknown value counts.
    assert!(!ignore.ignores("Other yes"));
}
