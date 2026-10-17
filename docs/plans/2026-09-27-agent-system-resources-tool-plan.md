# Agent system resources tool

Status: Implemented; repository-wide validation partial

## Goal and ownership

Expose a read-only `get_system_resources` tool to every provider through bigbud's existing thread-tool bridges. `bigbud-system` remains the sole observer and calculator of operating-system resources. The tool reads a current snapshot from the same Electron-hosted Rust monitor used by the Resource Monitor UI. It never samples the server host independently, changes resources, or starts proactive alerts.

## Contract

- Return a bounded summary with desktop host identity, sample time, freshness, and Rust's explicit ready/warming/unsupported/denied/unavailable/stale field states. Include CPU, memory, network, and disk summary data. Exclude process rows, mount paths, and per-interface detail by default.
- If the desktop, native monitor, collector, or private bridge is absent or fails, return a typed unavailable result and reason. Never return cached data as though it were current.
- A tool invocation opens a short-lived subscription with optional process/disk/sensor inventory disabled, waits for a current snapshot within a fixed deadline, acknowledges it, and unsubscribes in `finally`. The UI's subscription and Rust sampler remain independent and shared.

## Trust and lifecycle

- Electron main serves a loopback-only endpoint with a random bearer token. It gives the endpoint and token to the backend through the existing private bootstrap pipe, retaining them in server memory rather than process environment so provider subprocesses cannot inherit them. Rotate the token on backend restart; reject requests after child exit and during shutdown.
- The endpoint accepts only one read-only operation, limits concurrent calls, request time, and response size. The backend tool calls this endpoint with a deadline. A standalone server has no endpoint and reports unavailable.
- Do not expose the endpoint via renderer IPC or the ordinary WebSocket API. Existing authenticated per-thread tool routes remain the provider-facing boundary.

## Agent discovery

- Register the provider-neutral tool in Codex, Copilot, and MCP-based orchestration bridges, and add a capability Track. Initial thread context and post-compaction context include the Track. The existing fifth-user-message reminder remains generic. The Track describes desktop-only availability; runtime calls report typed unavailable when desktop is absent. No metric samples enter routine prompts, and runtime connection changes do not by themselves trigger a capability delta.

## Validation

- Test token rejection, backend token rotation/invalidation, timeout and unavailable behavior, one-shot subscription cleanup, and response bounds.
- Test all provider registrations and the authenticated thread-tool route.
- Verify a real Rust child yields a current snapshot through the endpoint when available, while both UI views continue to work.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`. Rust checks are required only if Rust code changes; none are planned.

## Implementation evidence (2026-09-27)

- The private endpoint and server tool are implemented. The token crosses the existing bootstrap FD3 pipe and is retained in server memory; the backend child environment strips monitor credentials, so provider children cannot inherit them through environment variables.
- Focused tests pass for token rejection and rotation, in-flight revocation, no credential propagation, unavailable and stale responses, authenticated thread-tool access, provider registration, and a real debug Rust child returning a current snapshot through the endpoint.
- Scoped desktop and server typechecks and repository lint passed. The first full `bun run test --concurrency=1` stopped in concurrent web UI work: `ResourceNetworkInterfaces.test.tsx` expected `MTU: 1500 B` while the current view rendered `MTU: 1500.00 B`. That change is outside this tool's files. The combined suite must be rerun after the web owner resolves the mismatch.
- Combined Rust format, Clippy, and workspace tests passed on the current worktree, as reported by the parent implementation thread. Rust changes belong to another concurrent workstream.
