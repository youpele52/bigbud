#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    CatchingUp { server_epoch: String },
    Live { server_epoch: String },
    Suspect { server_epoch: String },
    Reconnecting { server_epoch: Option<String> },
    BootstrapRequired { server_epoch: String },
    ShuttingDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionAction {
    None,
    SendHeartbeat,
    ForceReconnect,
    Replay,
    Bootstrap,
}

#[derive(Debug)]
pub struct TransportHealth {
    state: ConnectionState,
    heartbeat_interval_ms: u64,
    suspect_after_ms: u64,
    reconnect_after_ms: u64,
    last_protocol_frame_ms: u64,
    last_heartbeat_sent_ms: u64,
}

impl TransportHealth {
    pub fn new(heartbeat_interval_ms: u64, suspect_after_ms: u64, reconnect_after_ms: u64) -> Self {
        Self {
            state: ConnectionState::Disconnected,
            heartbeat_interval_ms,
            suspect_after_ms,
            reconnect_after_ms,
            last_protocol_frame_ms: 0,
            last_heartbeat_sent_ms: 0,
        }
    }

    pub fn state(&self) -> &ConnectionState {
        &self.state
    }

    pub fn start_connecting(&mut self) {
        self.state = ConnectionState::Connecting;
    }

    pub fn connected(&mut self, server_epoch: String, now_ms: u64) -> ConnectionAction {
        self.last_protocol_frame_ms = now_ms;
        self.last_heartbeat_sent_ms = now_ms;
        self.state = ConnectionState::CatchingUp { server_epoch };
        ConnectionAction::Replay
    }

    pub fn caught_up(&mut self) {
        if let ConnectionState::CatchingUp { server_epoch } = &self.state {
            self.state = ConnectionState::Live {
                server_epoch: server_epoch.clone(),
            };
        }
    }

    pub fn observed_protocol_frame(&mut self, now_ms: u64) {
        self.last_protocol_frame_ms = now_ms;
        if let ConnectionState::Suspect { server_epoch } = &self.state {
            self.state = ConnectionState::Live {
                server_epoch: server_epoch.clone(),
            };
        }
    }

    pub fn tick(&mut self, now_ms: u64) -> ConnectionAction {
        let silence_ms = now_ms.saturating_sub(self.last_protocol_frame_ms);
        let server_epoch = match &self.state {
            ConnectionState::Live { server_epoch } | ConnectionState::Suspect { server_epoch } => {
                Some(server_epoch.clone())
            }
            _ => None,
        };
        let Some(server_epoch) = server_epoch else {
            return ConnectionAction::None;
        };
        if silence_ms >= self.reconnect_after_ms {
            self.state = ConnectionState::Reconnecting {
                server_epoch: Some(server_epoch),
            };
            return ConnectionAction::ForceReconnect;
        }
        if silence_ms >= self.suspect_after_ms {
            self.state = ConnectionState::Suspect { server_epoch };
        }
        if now_ms.saturating_sub(self.last_heartbeat_sent_ms) >= self.heartbeat_interval_ms {
            self.last_heartbeat_sent_ms = now_ms;
            return ConnectionAction::SendHeartbeat;
        }
        ConnectionAction::None
    }

    pub fn replay_unavailable(&mut self) -> ConnectionAction {
        let server_epoch = match &self.state {
            ConnectionState::CatchingUp { server_epoch }
            | ConnectionState::Live { server_epoch }
            | ConnectionState::Suspect { server_epoch } => server_epoch.clone(),
            ConnectionState::Reconnecting {
                server_epoch: Some(server_epoch),
            } => server_epoch.clone(),
            _ => return ConnectionAction::None,
        };
        self.state = ConnectionState::BootstrapRequired { server_epoch };
        ConnectionAction::Bootstrap
    }

    pub fn bootstrap_installed(&mut self) {
        if let ConnectionState::BootstrapRequired { server_epoch } = &self.state {
            self.state = ConnectionState::Live {
                server_epoch: server_epoch.clone(),
            };
        }
    }

    pub fn shutdown(&mut self) {
        self.state = ConnectionState::ShuttingDown;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_stream_uses_protocol_heartbeats_before_reconnecting() {
        let mut health = TransportHealth::new(5_000, 15_000, 20_000);
        health.start_connecting();
        assert_eq!(
            health.connected("epoch-1".to_owned(), 100),
            ConnectionAction::Replay
        );
        health.caught_up();
        assert_eq!(health.tick(5_100), ConnectionAction::SendHeartbeat);
        assert_eq!(health.tick(15_100), ConnectionAction::SendHeartbeat);
        assert!(matches!(health.state(), ConnectionState::Suspect { .. }));
        assert_eq!(health.tick(20_100), ConnectionAction::ForceReconnect);
    }

    #[test]
    fn protocol_activity_recovers_a_suspect_connection() {
        let mut health = TransportHealth::new(5_000, 15_000, 20_000);
        health.connected("epoch-1".to_owned(), 0);
        health.caught_up();
        health.tick(15_000);
        health.observed_protocol_frame(15_001);
        assert!(matches!(health.state(), ConnectionState::Live { .. }));
    }

    #[test]
    fn replay_gap_requires_bounded_bootstrap() {
        let mut health = TransportHealth::new(5_000, 15_000, 20_000);
        health.connected("epoch-1".to_owned(), 0);
        assert_eq!(health.replay_unavailable(), ConnectionAction::Bootstrap);
        assert!(matches!(
            health.state(),
            ConnectionState::BootstrapRequired { .. }
        ));
        health.bootstrap_installed();
        assert!(matches!(health.state(), ConnectionState::Live { .. }));
    }
}
