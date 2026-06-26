# Mobile Remote Control Plan

## Status

Proposed, revised after repository review.

Task 10 should be treated as a **mobile web remote control** project, not a Telegram-first project.

## Recommendation

Build a **lean mobile web companion as `apps/mobile-web`** and pair it to the existing server with a **scoped, short-lived mobile session**.

Do not make Telegram the primary control path.

Use:

1. A separate mobile app boundary in `apps/mobile-web`
2. The same Vite + TanStack Router stack already used by `apps/web`
3. The existing WebSocket RPC transport at `/ws`
4. The existing orchestration contracts for snapshot, event stream, dispatch, and diff
5. Extracted shared view-model and RPC helpers where reuse is actually clean

Telegram can be added later only for notifications and deep links.

## Why This Is The Right Shape

The current stack already matches a remote-control product better than a chat-bot product:

1. The server already exposes WebSocket RPC at [apps/server/src/ws/ws.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/ws/ws.ts).
2. The web app already talks to the server through a browser-safe WebSocket client in [apps/web/src/rpc/wsRpcClient.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/rpc/wsRpcClient.ts) and [apps/web/src/rpc/wsNativeApi.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/rpc/wsNativeApi.ts).
3. Thread control already exists as contracts, not UI-only behavior, in [packages/contracts/src/orchestration/orchestration.rpc.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/orchestration/orchestration.rpc.ts) and [packages/contracts/src/orchestration/orchestration.commands.client.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/orchestration/orchestration.commands.client.ts).
4. The app already uses Vite and TanStack Router in [apps/web/vite.config.ts](/Users/youpele/DevWorld/bigbud/apps/web/vite.config.ts) and [apps/web/src/config/router/router.config.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/config/router/router.config.ts), so a second web app can stay aligned without inventing a new stack.

The missing pieces are not transport or framework. The missing pieces are:

1. Mobile-safe session scoping
2. Pairing UX
3. Network reachability from phone to desktop
4. A deliberately smaller mobile UI

## What The Old Plan Missed

The previous draft was directionally correct, but not implementation-ready.

Important gaps:

1. **Reachability was underspecified.** Desktop mode binds to `127.0.0.1` by default in [apps/server/src/cli/cli.config.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/cli/cli.config.ts), so a phone cannot connect unless the app explicitly enables a LAN-reachable bind or some future relay/tunnel.
2. **The reuse boundary was too vague.** Reusing “the web app” is good; reusing the entire desktop layout is not. The mobile surface must reuse data/model/transport layers, but only selected UI components.
3. **The auth model stopped too early.** “Scoped mobile session” is correct, but the plan did not define scope shape, storage, expiration, confirmation, or revocation.
4. **Telegram was overrepresented.** It is useful later, but it adds another identity and lifecycle system without solving the core mobile-control problem.
5. **There was no phased v1/v2 network strategy.** LAN-first and internet-remote access have very different risk profiles. They should not be mixed into one “just works everywhere” milestone.
6. **The current `apps/web` shell is not actually a good mobile boundary.** The existing app is heavily desktop-shaped and already assumes desktop bootstrap paths in places like [apps/web/src/routes/\_\_root.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/routes/__root.tsx). A separate app can still reuse contracts and helpers without inheriting the whole shell.

## Product Decision

### v1

Ship a **LAN-first mobile web control surface** with QR pairing.

Capabilities:

1. List threads
2. Open a thread
3. Watch live events
4. Send a prompt
5. Interrupt a running turn
6. Approve or reject pending approvals
7. View thread diff summary or full diff text
8. Archive thread

Not in v1:

1. Full desktop parity
2. Terminal control
3. Notes, kanban, files, browser panel, settings
4. Multi-project admin flows
5. Internet-wide remote access
6. Telegram as a primary UI

### v2

Add optional remote access beyond LAN:

1. Tailnet/Tailscale-friendly bind support, or
2. A proper relay/tunnel service

However, design the auth/session model in v1 so those transports can be added without changing the client trust model.

## Architecture Decision

### Frontend

Use a dedicated `apps/mobile-web` app.

Recommended structure:

1. Create `apps/mobile-web` with the same core browser stack: Vite, React, TanStack Router, TanStack Query
2. Share contracts from `packages/contracts`
3. Extract reusable RPC/bootstrap helpers from `apps/web` only where the dependency direction stays clean
4. Keep mobile-specific layout, routing, and state isolated from desktop shell state

Why a separate app is better here:

1. The mobile surface is intentionally narrower and should stay that way
2. It avoids coupling to desktop-only shell assumptions, panel state, and keyboard behavior
3. It makes bundle size and screen flow easier to control
4. It reduces the risk of accidental desktop regressions while iterating on mobile
5. It matches the companion-product shape seen in Orca, where mobile is intentionally a separate remote-control surface rather than a shrunk editor

What must still be reused:

1. Contracts and schemas
2. WebSocket transport semantics
3. Auth/session model
4. Thread read-model logic where extractable
5. Approval and diff domain helpers where extractable

Why not just responsive-desktop everywhere:

1. The desktop shell has too much panel state and keyboard-driven behavior
2. A phone needs task-focused flows, not a shrunk workstation layout

### Backend

Keep the existing server as the control plane.

Add:

1. Pairing HTTP endpoints
2. Mobile-session issuance and revocation
3. WebSocket auth that accepts either the existing desktop token or a scoped mobile session token
4. Optional mobile permission checks around dangerous RPCs

## Security And Session Model

The QR code must never contain the long-lived desktop WebSocket token.

### Pairing Flow

1. Desktop user opens “Mobile Remote” in the desktop app.
2. Desktop asks the server to create a single-use pairing record.
3. Server returns:
   1. Pairing ID
   2. Expiry timestamp
   3. Allowed scope preset
4. Desktop renders a QR URL such as `http://<lan-host>:<port>/m/pair/<pairing-id>`.
5. Phone opens the URL and shows pairing details.
6. Desktop must explicitly confirm the pairing request.
7. Server exchanges the pairing record into a mobile session token.
8. Phone reconnects using the mobile session token.

### Mobile Session Properties

Each mobile session should have:

1. Token ID
2. Secret token value
3. Created at
4. Last used at
5. Expires at
6. Scope
7. Optional allowed project IDs
8. Optional allowed thread IDs
9. Human label such as device name
10. Revoked at

### Scope Presets

Keep v1 simple. Support only these presets:

1. `read-only`
2. `approve-only`
3. `thread-control`

Avoid `full-control` in v1.

`thread-control` should allow:

1. Reading snapshot
2. Receiving orchestration streams
3. Starting a turn
4. Interrupting a turn
5. Responding to approvals
6. Reading diff data
7. Archiving a thread

It should not allow:

1. Arbitrary file writes
2. Terminal session control
3. Settings mutation
4. Provider refresh/admin actions

### Storage

Use the same persistence style as existing server-side tokenized utilities where possible. The internal thread-tool auth flow in [apps/server/src/ws/http.threadTools.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/ws/http.threadTools.ts) and [apps/server/src/orchestration-tools/threadOrchestrationBridge.shared.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/orchestration-tools/threadOrchestrationBridge.shared.ts) is a good precedent for:

1. Token creation
2. Token lookup
3. Narrow authorization checks

For mobile sessions, prefer a proper persisted store over ad hoc files once the shape settles, because revocation and expiration matter more here.

## Networking Strategy

This is the biggest non-UI constraint.

Desktop mode currently defaults to loopback-only binding. That is safe, but unusable from a phone.

### v1 Networking Rule

Remote control must be **disabled by default** and explicitly enabled by the user.

When enabled:

1. Server binds to a LAN-reachable interface
2. Server shows the exact reachable URL in the desktop UI
3. Desktop UI warns that anyone on the same network can reach the server if they obtain a valid token
4. Mobile sessions remain required even on LAN

Recommended first implementation:

1. Keep existing default `127.0.0.1`
2. Add an opt-in “Enable mobile control on local network” setting
3. Rebind server to `0.0.0.0` or a chosen interface only when enabled
4. Prefer showing both QR and copyable URL

### v1.5 Remote-Friendly Extension

The next network step after LAN should be Tailscale/Tailnet-first, not a generic public tunnel.

Why:

1. `t3code` already treats tailnet/private-network exposure as the recommended remote-access path in [REMOTE.md](https://raw.githubusercontent.com/pingdotgg/t3code/main/REMOTE.md).
2. `synara` documents the same shape: bind to LAN or directly to a Tailnet IP and require an auth token in [REMOTE.md](https://raw.githubusercontent.com/Emanuele-web04/synara/main/REMOTE.md).
3. Tailnet exposure keeps the server off the public internet while still solving “use from anywhere.”

Recommended order:

1. LAN opt-in
2. Tailnet/Tailscale-friendly bind and endpoint selection
3. Only then consider a relay or general-purpose tunnel

Out of scope for v1:

1. NAT traversal
2. Public internet exposure
3. Cloud relay
4. Unauthenticated discovery

## Mobile UX

The mobile app should be optimized for quick remote supervision, not desktop replacement.

### Screen Set

Use a small route set inside `apps/mobile-web`:

1. `/m`
   Shows paired device status and thread list
2. `/m/thread/$threadId`
   Shows message timeline, status, pending approval, composer, and diff entry points
3. `/m/thread/$threadId/diff`
   Shows the latest full-thread diff or selected turn diff
4. `/m/pair/$pairingId`
   Pairing and confirmation flow

### Mobile UI Principles

1. One main column
2. Sticky top bar with connection/session state
3. Sticky bottom composer or approval actions
4. Avoid sidebars and multi-panel layouts
5. Prefer explicit buttons over hover or keyboard affordances

### Reuse Guidance

Safe reuse targets:

1. Orchestration state and subscriptions
2. Thread read models
3. Command dispatch helpers
4. Approval description logic such as [apps/web/src/components/chat/composer/pendingApproval.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/components/chat/composer/pendingApproval.ts)
5. Diff data fetching logic

Do not reuse directly unless proven small-screen-safe:

1. Desktop sidebar shell
2. Right-panel infrastructure
3. Terminal drawer
4. Keyboard-first controls
5. Dense composer/header stacks

## Detailed Build Plan

### Phase 0: Narrow The Scope

Decide and lock these v1 constraints:

1. LAN-only
2. Single-user pairing initiated from desktop
3. Scoped mobile sessions
4. Thread-focused controls only

This decision should be reflected in docs and copy before implementation begins.

Also lock one architectural rule:

1. `apps/mobile-web` is a companion app, not a responsive fork of the desktop shell

### Phase 1: Server Auth Foundation

Add a server-side mobile auth module.

Responsibilities:

1. Create pairing records
2. Validate pairing records
3. Exchange pairing records into mobile sessions
4. Revoke mobile sessions
5. Expire stale pairing records and sessions
6. Resolve incoming WebSocket auth into an auth context

Output shape:

1. `desktop-token` auth context for the current full-access path
2. `mobile-session` auth context with scope metadata

### Phase 2: Pairing HTTP Endpoints

Add HTTP endpoints for:

1. Create pairing record
2. Read pairing status
3. Confirm pairing
4. Exchange pairing for mobile session
5. Revoke mobile session

Suggested path family:

1. `/api/mobile/pairing/create`
2. `/api/mobile/pairing/:id`
3. `/api/mobile/pairing/:id/confirm`
4. `/api/mobile/pairing/:id/exchange`
5. `/api/mobile/session/:id/revoke`

The exact paths can be adjusted to fit existing server route conventions.

### Phase 3: WebSocket Auth Expansion

Update `/ws` auth to support:

1. Existing desktop `token`
2. New mobile session token

The WebSocket layer should attach a resolved auth context so downstream handlers can enforce scope where needed.

Keep the current desktop path fully backward compatible.

### Phase 4: Permission Gates

Before exposing the mobile UI, add server-side permission checks for RPC methods that mobile should not call.

At minimum:

1. Allow orchestration read APIs
2. Allow orchestration dispatch only for approved thread commands
3. Deny terminal RPCs
4. Deny settings mutations
5. Deny workspace write APIs
6. Deny provider/admin RPCs

This matters even if the mobile UI hides those controls, because the browser client can still be scripted.

### Phase 5: Desktop Entry Point

Add a desktop UI surface to:

1. Enable or disable mobile control
2. Create a pairing QR
3. Show expiry countdown
4. Show current paired mobile sessions
5. Revoke active mobile sessions

The desktop UI should also clearly display:

1. LAN-only status
2. Host and port
3. Scope of the pairing being granted

### Phase 6: Mobile App Skeleton

Create `apps/mobile-web`.

Recommended implementation:

1. Mirror the existing browser stack from `apps/web`
2. Add a small mobile router
3. Add a mobile session loader/guard
4. Reuse extracted WS client pieces with mobile-session token injection
5. Keep desktop shell code out of the app entirely

### Phase 7: Mobile Thread List

Build the minimum home screen:

1. Show active threads first
2. Show pending approvals prominently
3. Show project title, thread title, provider, and status
4. Tap to open thread detail

Do not include bulk actions in v1.

### Phase 8: Mobile Thread Detail

Build the minimum thread control screen:

1. Timeline of messages and important events
2. Current run state
3. Pending approval card
4. Prompt composer
5. Interrupt action when running
6. Archive action
7. Open latest diff action

If timeline virtualization adds complexity on mobile, prefer a bounded initial implementation over porting the entire desktop timeline behavior immediately.

### Phase 9: Diff View

Add a minimal diff screen that reuses existing diff fetching but simplifies rendering.

v1 target:

1. Latest diff summary
2. Full-thread diff text view
3. Basic file grouping if cheap to reuse

Do not chase full desktop diff parity in the first slice.

### Phase 10: Remote-Friendly Foundation

Before calling the architecture stable, add the non-UI pieces needed for remote access beyond LAN without changing the client model:

1. Endpoint metadata model
2. Saved reachable endpoint selection
3. Support for LAN and Tailnet endpoint types
4. Session auth independent of transport
5. Pairing URLs that can carry backend origin plus one-time credential

This is where “focus on v2” belongs. The transport abstraction should be laid now, even if only LAN ships first.

### Phase 11: Hardening

Before calling the feature complete:

1. Reconnect with session continuity
2. Pairing expiry behavior
3. Duplicate scan handling
4. Session revocation while mobile is connected
5. Desktop app restart behavior
6. Mobile browser refresh behavior
7. Scope enforcement tests

## Testing Plan

### Server

Add tests for:

1. Pairing record creation and expiration
2. Pairing exchange success and failure
3. WebSocket auth acceptance for mobile session token
4. WebSocket auth rejection for expired or revoked mobile session
5. RPC permission denial for disallowed methods

### Web

Add browser tests for:

1. Mobile pairing route
2. Thread list rendering on narrow viewport
3. Approval response flow
4. Prompt send flow
5. Interrupt flow
6. Reconnect after transient disconnect

## Telegram Decision

Telegram should be explicitly postponed.

Rationale:

1. It does not solve server reachability
2. It does not solve scoped session auth
3. It is a worse fit for diff-heavy and streaming thread control
4. It creates a second product surface too early

If added later, keep it limited to:

1. Notifications
2. Approval nudges
3. Deep links into the `/m` mobile app

If a Telegram Mini App is ever added, it should host the same mobile web surface, not a second control system.

## Concrete Deliverable For Task 10

Task 10 should be considered complete when this direction is accepted:

1. **Primary path:** a lean companion app in `apps/mobile-web`
2. **Transport:** existing WebSocket RPC
3. **Framework choice:** keep current Vite + TanStack Router stack
4. **Security:** QR pairing issues scoped mobile sessions, never the desktop token
5. **Network strategy:** LAN-first shipping path, but remote-friendly auth/network abstraction from day one
6. **Scope:** thread list, thread detail, approvals, prompt send, interrupt, diff
7. **Telegram:** deferred to notification/deep-link companion only

## Next Step

The next implementation step should be a small technical design doc for the server auth pieces:

1. pairing record schema
2. mobile session schema
3. `/ws` auth context shape
4. exact list of RPC methods allowed for `thread-control`

That work should happen before any mobile UI coding.
