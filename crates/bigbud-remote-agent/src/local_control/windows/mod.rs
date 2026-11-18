mod client;
mod io;
mod pipe;
mod server;
pub(super) use client::run_client;
pub(super) use server::run_server;

pub(crate) use pipe::prior_owner_dead;

#[cfg(test)]
mod tests;
