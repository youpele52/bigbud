pub const fn build_version() -> &'static str {
    match option_env!("BIGBUD_AGENT_BUILD_VERSION") {
        Some(version) => version,
        None => env!("CARGO_PKG_VERSION"),
    }
}

pub const fn build_digest() -> &'static str {
    match option_env!("BIGBUD_AGENT_BUILD_DIGEST") {
        Some(digest) => digest,
        None => env!("CARGO_PKG_VERSION"),
    }
}
