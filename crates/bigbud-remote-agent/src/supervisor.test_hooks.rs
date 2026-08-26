use std::path::PathBuf;
use std::time::Duration;

pub(super) fn wait_before_process_spawn(operation_id: &str) {
    let Ok(root) = std::env::var("BIGBUD_TEST_PROCESS_SPAWN_BARRIER") else {
        return;
    };
    let root = PathBuf::from(root);
    std::fs::write(root.join("accepted"), operation_id).unwrap();
    while !root.join("release").exists() {
        std::thread::sleep(Duration::from_millis(5));
    }
}
