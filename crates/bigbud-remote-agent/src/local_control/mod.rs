//! Account-scoped CLI transport; request validation and installation remain in TypeScript.
pub(crate) mod protocol;
#[cfg(windows)]
pub(crate) mod windows;

pub fn run_server() -> std::io::Result<()> {
    #[cfg(windows)]
    return windows::run_server();
    #[cfg(not(windows))]
    Err(std::io::Error::other("unsupported local pipe platform"))
}
pub fn run_client() -> std::io::Result<()> {
    #[cfg(windows)]
    return windows::run_client();
    #[cfg(not(windows))]
    Err(std::io::Error::other("unsupported local pipe platform"))
}
