pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.remote_agent.v1.rs"));
}

pub mod service_lease {
    pub mod v1 {
        include!(concat!(
            env!("OUT_DIR"),
            "/bigbud.remote_agent.service_lease.v1.rs"
        ));
    }
}
