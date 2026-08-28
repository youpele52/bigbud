# bigbud desktop supervisor

This crate provides the provider-neutral, bounded delivery coordinator used by
the packaged desktop runtime. When the verified native binary is present,
`apps/desktop` supplies its path and the packaged server launches it through
`DesktopSupervisorOwnerClient` in supervisor mode. The supervisor owns bounded
child-process delivery state and transport reliability; it does not own
threads, projects, provider sessions, credentials, or canonical history.

The TypeScript server and SQLite remain the canonical domain authority. They
provide orchestration events, verified application-ACK cursors, replay data,
and user-visible connection state. On supervisor failure, the server fences
the old generation, restarts and reattaches within a bounded recovery budget,
then replays from the verified cursor. An unavailable replay suffix or
exhausted recovery budget is surfaced as a fenced fallback; it does not permit
an unsafe supervisor switchback.

Runtime modes are deliberate:

- packaged desktop with a valid configured binary: `supervisor`;
- standalone server: `direct-unmanaged`, unless explicitly enabled;
- unsupported or invalid packaged setup: `fallback-fenced`.

The framed stdin/stdout protocol in `protocol/desktop-supervisor/v1.proto`
defines the handshake, consumer generations, replay cursor, acknowledgements,
timeouts, duplicate handling, and bounded queues. Signing, notarization,
native artifact publication, and broad release or soak certification remain
external release gates and are not established by this crate alone.
