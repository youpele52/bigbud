//! Generated schema owned by protocol/thread-organization; no runtime authority.
pub mod facts {
    pub mod v1 {
        include!(concat!(
            env!("OUT_DIR"),
            "/bigbud.thread_organization.facts.v1.rs"
        ));
    }
}
pub mod policy {
    pub mod v1 {
        include!(concat!(
            env!("OUT_DIR"),
            "/bigbud.thread_organization.policy.v1.rs"
        ));
    }
}
pub mod scheduling {
    pub mod v1 {
        include!(concat!(
            env!("OUT_DIR"),
            "/bigbud.thread_organization.scheduling.v1.rs"
        ));
    }
}
pub mod v1 {
    include!(concat!(
        env!("OUT_DIR"),
        "/bigbud.thread_organization.v1.rs"
    ));
}
