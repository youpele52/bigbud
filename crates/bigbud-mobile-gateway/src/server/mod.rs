//! Accept loop, connection budget and bounded shutdown.

mod connection;
pub mod shared;

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::{Semaphore, watch};

use crate::config::{ConfigError, GatewayConfig};
use shared::{Shared, log_event};

/// Concurrent over-limit rejections that get a polite 503; beyond this they are dropped.
const MAX_CONCURRENT_REJECTIONS: usize = 4;
/// How long shutdown waits for connections and relays to finish closing.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("invalid configuration: {0}")]
    Config(#[from] ConfigError),
    #[error("io: {0}")]
    Io(#[from] io::Error),
}

pub struct Gateway {
    listener: std::net::TcpListener,
    shared: Arc<Shared>,
    shutdown: Arc<watch::Sender<bool>>,
}

/// Stops the accept loop and closes every connection and relay. Callable from
/// any thread, including outside the gateway's runtime.
#[derive(Clone, Debug)]
pub struct ShutdownHandle {
    shutdown: Arc<watch::Sender<bool>>,
}

impl ShutdownHandle {
    pub fn shutdown(&self) {
        // `send_replace` succeeds even with no receivers left.
        self.shutdown.send_replace(true);
    }
}

impl Gateway {
    /// Validates configuration and binds the loopback listener. No runtime,
    /// thread or task starts until [`Gateway::run`].
    pub fn bind(config: GatewayConfig) -> Result<Self, GatewayError> {
        config.validate()?;
        let listener = std::net::TcpListener::bind(config.listen)?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener,
            shared: Arc::new(Shared::new(config)),
            shutdown: Arc::new(watch::channel(false).0),
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    pub fn shutdown_handle(&self) -> ShutdownHandle {
        ShutdownHandle {
            shutdown: Arc::clone(&self.shutdown),
        }
    }

    /// Serves on a dedicated single-threaded runtime until shutdown, then waits
    /// (bounded) for every connection and relay to release its slot.
    pub fn run(self) -> Result<(), GatewayError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(self.serve())
    }

    async fn serve(self) -> Result<(), GatewayError> {
        let listener = TcpListener::from_std(self.listener)?;
        let max_connections = self.shared.config.limits.max_connections;
        let slots = Arc::new(Semaphore::new(max_connections));
        let rejections = Arc::new(Semaphore::new(MAX_CONCURRENT_REJECTIONS));
        let mut shutdown = self.shutdown.subscribe();
        loop {
            if *shutdown.borrow() {
                break;
            }
            tokio::select! {
                changed = shutdown.changed() => if changed.is_err() { break },
                accepted = listener.accept() => {
                    let stream = match accepted {
                        Ok((stream, _)) => stream,
                        Err(error) if is_transient_accept_error(&error) => continue,
                        Err(error) => return Err(GatewayError::Io(error)),
                    };
                    match Arc::clone(&slots).try_acquire_owned() {
                        Ok(permit) => {
                            let shared = Arc::clone(&self.shared);
                            let watcher = self.shutdown.subscribe();
                            tokio::spawn(connection::serve(stream, shared, permit, watcher));
                        }
                        Err(_) => {
                            log_event("reject", "connection-limit");
                            if let Ok(permit) = Arc::clone(&rejections).try_acquire_owned() {
                                tokio::spawn(connection::reject_over_limit(stream, permit));
                            }
                        }
                    }
                }
            }
        }
        drop(listener);
        self.shutdown.send_replace(true);
        // Every connection and relay holds a slot; all slots back means all closed.
        let all = u32::try_from(max_connections).unwrap_or(u32::MAX);
        if tokio::time::timeout(SHUTDOWN_GRACE, slots.acquire_many(all))
            .await
            .is_err()
        {
            log_event("shutdown-grace-expired", "dropping-remaining");
        }
        Ok(())
    }
}

fn is_transient_accept_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::Interrupted
            | io::ErrorKind::WouldBlock
    )
}
