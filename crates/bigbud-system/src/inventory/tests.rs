use super::*;
fn row(pid: u32) -> ProcessRecord {
    ProcessRecord {
        pid,
        parent_pid: None,
        name: "x".into(),
        status: "Run".into(),
        start_time_seconds: 0,
        run_time_seconds: 0,
        cpu_percent: Some(pid as f32),
        cpu_status: Availability::Ready,
        resident_bytes: 0,
        virtual_bytes: 0,
        disk_read_bytes: 0,
        disk_written_bytes: 0,
        disk_io_status: Availability::Unavailable,
    }
}
#[test]
fn bounds_and_cursor_generation() {
    let at = Instant::now();
    let inventory = Inventory::from_records(1, at, (0..20_001).map(row));
    assert_eq!(inventory.len(), MAX_RECORDS);
    assert!(inventory.truncated);
    let mut store = InventoryStore::default();
    store.replace(inventory, at);
    let query = Query {
        limit: 2,
        ..Query::default()
    };
    let page = store.query(&query, None, at).unwrap();
    assert_eq!(page.rows[0].pid, 19_999);
    let cursor = page.next.unwrap();
    store.replace(Inventory::from_records(2, at, [row(30)]), at);
    assert_eq!(
        store.query(&query, Some(&cursor), at).unwrap().rows[0].pid,
        19_997
    );
    assert_eq!(
        store
            .query(&query, Some(&cursor), at + Duration::from_secs(31))
            .unwrap_err(),
        QueryError::StaleQuery
    );
}
#[test]
fn validates_query_and_utf8() {
    assert_eq!(truncate_utf8("éé", 3), "é");
    let mut store = InventoryStore::default();
    let query = Query {
        limit: 101,
        ..Query::default()
    };
    assert_eq!(
        store.query(&query, None, Instant::now()).unwrap_err(),
        QueryError::Invalid
    );
}

#[test]
fn a_new_query_eviction_invalidates_old_cursor() {
    let at = Instant::now();
    let mut store = InventoryStore::default();
    store.replace(Inventory::from_records(1, at, [row(1), row(2), row(3)]), at);
    let first = Query {
        limit: 1,
        ..Query::default()
    };
    let cursor = store.query(&first, None, at).unwrap().next.unwrap();
    store.replace(Inventory::from_records(2, at, [row(4), row(5)]), at);
    let second = Query {
        name: Some("x".into()),
        limit: 1,
        ..Query::default()
    };
    let _ = store.query(&second, None, at).unwrap();
    assert_eq!(
        store.query(&first, Some(&cursor), at).unwrap_err(),
        QueryError::StaleQuery
    );
}

#[test]
fn byte_cap_truncates_large_sanitized_rows() {
    let at = Instant::now();
    let rows = (0..MAX_RECORDS as u32).map(|pid| {
        let mut record = row(pid);
        record.name = "x".repeat(256);
        record.status = "y".repeat(256);
        record
    });
    let inventory = Inventory::from_records(1, at, rows);
    assert!(inventory.len() < MAX_RECORDS);
    assert!(inventory.truncated);
}

#[test]
fn search_matches_name_pid_or_status_before_paginating() {
    let at = Instant::now();
    let mut named = row(12);
    named.name = "Running Board".into();
    named.status = "Sleep".into();
    let mut status = row(21);
    status.name = "Other".into();
    status.status = "Run".into();
    let mut store = InventoryStore::default();
    store.replace(Inventory::from_records(1, at, [named, status]), at);
    let query = Query {
        search: Some("run".into()),
        limit: 1,
        ..Query::default()
    };
    let first = store.query(&query, None, at).unwrap();
    assert_eq!(first.rows[0].pid, 21);
    assert_eq!(
        store.query(&query, first.next.as_ref(), at).unwrap().rows[0].pid,
        12
    );
    let pid_query = Query {
        search: Some("12".into()),
        ..Query::default()
    };
    assert_eq!(store.query(&pid_query, None, at).unwrap().rows[0].pid, 12);
    assert_eq!(
        store
            .query(&pid_query, first.next.as_ref(), at)
            .unwrap_err(),
        QueryError::StaleQuery
    );
}
