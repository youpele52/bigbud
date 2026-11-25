use super::*;

const NO_PRIVILEGES: &str = "Name:\towner\nCapInh:\t0000000000000000\n\
CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\n\
CapAmb:\t0000000000000000\nNoNewPrivs:\t1\n";
const ROOT: &str = "1 0 0:10 /newroot / ro - tmpfs tmpfs rw\n";
const BIN: &str = "2 1 0:20 /image/usr/bin /usr/bin ro,nosuid,nodev - tmpfs tmpfs rw\n";

#[test]
fn rejects_root_or_broader_namespace_mappings() {
    assert!(sole_mapping(" 501 0 1\n", 501));
    assert!(!sole_mapping("0 0 4294967295\n", 501));
    assert!(!sole_mapping("501 0 2\n", 501));
    assert!(!sole_mapping("501 0 1\n502 1001 1\n", 501));
    assert!(!sole_mapping("501 fake 1\n", 501));
}

#[test]
fn requires_all_capability_sets_to_be_dropped_and_no_new_privileges() {
    assert!(dropped_privileges(NO_PRIVILEGES));
    for name in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] {
        let populated = NO_PRIVILEGES.replace(
            &format!("{name}:\t0000000000000000"),
            &format!("{name}:\t0000000000000001"),
        );
        assert!(!dropped_privileges(&populated), "{name}");
    }
    assert!(!dropped_privileges(
        &NO_PRIVILEGES.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0")
    ));
    assert!(!dropped_privileges(
        &NO_PRIVILEGES.replace("CapBnd:", "missing:")
    ));
}

#[test]
fn requires_an_explicit_read_only_tools_mount_without_overlays() {
    assert!(explicit_tools_mount(&format!("{ROOT}{BIN}")));
    assert!(!explicit_tools_mount(ROOT));
    assert!(!explicit_tools_mount(
        &BIN.replace("ro,nosuid", "rw,nosuid")
    ));
    assert!(!explicit_tools_mount(
        &BIN.replace("/usr/bin ro", "/usr/bin-old ro")
    ));
    assert!(!explicit_tools_mount(&format!("{ROOT}{BIN}{BIN}")));
    assert!(!explicit_tools_mount(&format!(
        "{ROOT}{BIN}3 2 0:30 /substitute /usr/bin/ssh ro - tmpfs tmpfs ro\n"
    )));
}
