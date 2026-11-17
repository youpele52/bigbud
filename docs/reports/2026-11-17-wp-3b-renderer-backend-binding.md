# WP-3B: renderer per-window backend binding

**Date:** 17 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M2 WP-3B, decision 2
(one window per remote backend)
**State:** Implemented and unit/browser tested against the relay-lease contract and test doubles.
Not live-tested. Not committed.

## What changed

A renderer window opened with `?backend=<profileId>` binds to that one remote backend before the
app renders. A window without the parameter behaves exactly as before.

Binding flow (`apps/web/src/rpc/backendScope.ts`):

1. Read `?backend=`. Absent: return `local` at once. Malformed: typed `invalid-profile`.
2. Open a **private** control connection to the local backend (its own `WsTransport`, backoff and
   silent observers; only the three relay methods). Relay leases are bound to a live local RPC
   connection, so this connection lives as long as the window.
3. List relay profiles. `setup-required` or a missing profile gives a typed unavailable state.
4. Open a relay lease with a caller nonce (a lost reply is cancelled by `requestId`).
5. `openRemoteBackendClientOwner` with the profile's identity pin. The endpoint resolver reads
   `GET <lease>/api/remote-backend/handshake` with `Authorization: Bearer <localCredential>` and
   connects to `ws://127.0.0.1:<port>/ws?token=…&clientRpcRevision=1`. On every reconnect the pin
   and revision are re-checked. If the lease is unreachable (for example after a local backend
   restart), the old lease is released and a new one is opened.
6. Publish the bound state: `readNativeApi()` and `getWsRpcClient()` return the owned API and
   client, and assets use the lease origin.

`main.tsx` awaits `bootstrapBackendScope()` before rendering. `BackendScopeGate` keeps the app
unmounted unless the window is local or bound. A later refusal (for example a key rotation on
reconnect) replaces the app with guidance.

### Never touching the local singletons

In a `?backend=` window, from the first module load (the URL check is synchronous):

- `getWsRpcClient()` returns the owned client, or throws `BoundBackendNotReadyError`. It never
  builds the local transport or attaches the local diagnostics reporter.
- `readNativeApi()` returns the owned API or `undefined`. `createWsNativeApi()` throws.
- Delivery cursors use the backend-scoped namespace (`backend-v1`), never the legacy keys.
- `resolveWsHttpOrigin()` returns the lease origin, or `""` before binding. It never returns the
  local backend origin.

The bound transport does feed this window's own connection-state atoms, so the existing connection
UI works. These atoms are per renderer and are not a backend client.

### Assets and attachments

- `resolveWsHttpOrigin()` returns the lease `baseUrl`, and `resolveWsHttpRequestHeaders()` returns
  the bearer and `x-bigbud-client-rpc-revision` headers. The games metadata `fetch` now sends them.
- `<img>` and `<iframe>` loads cannot set headers. The bound window therefore sends its lease to
  the desktop shell (`bindRemoteBackendAssets`, accepted only from a `remote-backend` window and
  only for a loopback URL with a 64-hex credential). The shell adds the headers only for that
  window's `webContentsId` and only for that exact lease origin.

### Desktop

- `apps/desktop/src/window/remoteBackendWindow.ts`: one window per profile (focuses an existing
  one), role `remote-backend` (several live windows allowed), and IPC registration.
  `remoteBackendWindow.assets.ts` handles header injection.
- Channels `desktop:open-remote-backend-window` (any broad renderer) and
  `desktop:bind-remote-backend-assets` (`remote-backend` role only). Both are in the IPC
  authorization audit test.
- `createWindow` takes optional `searchParams`, and `makeWindow(searchParams)` registers as `main`
  only when it has none. The terminal-rendering policy also allows the new role.
- Contracts: `DesktopWindowRole` adds `"remote-backend"`, and the bridge types are in
  `server/ipc.desktopRemoteBackend.ts`.

### Sidebar

The footer has an "Open remote backend" entry that appears only after the relay lists at least
one profile. The list is read again each time the menu opens. If the relay then reports none, the
menu shows the typed reason in amber. The entry is hidden in bound windows and outside desktop.

### Admission refusal guidance

`unsupported-revision` shows "Update required" (red) with update guidance and a Retry button.
Identity changes show "Remote backend identity changed" without Retry. `setup-required` and
`not-found` are amber, and `relay-failed` is red with Retry.

## Pending WP-3A (profile producer)

- Production still uses `RemoteBackendRelayProfilesUnavailable`, so `list` returns
  `setup-required`. The sidebar entry stays hidden and a hand-opened `?backend=` window shows
  "Remote backends unavailable". Everything here is tested with relay doubles only.
- **Server follow-up, not changed here:** the relay owner allows only the origins
  `http://127.0.0.1:<port>`, `http://localhost:<port>` and the dev URL. A packaged desktop
  renderer runs at `bigbud://app`, so its handshake fetch and WebSocket would get 403 until WP-3A
  (or a small server change) allows the desktop scheme origin. In dev (Vite origin) it is
  allowed.

## Notes for WP-3C (backend-scoped storage)

- A bound window shares `localStorage` with the local window (same renderer origin and session).
  Every persisted store except the delivery cursor still uses unscoped keys. WP-3C should
  namespace them with the same `backend-v1` + authority + installation identity that
  `createScopedDeliveryCursor` uses (`readBackendScope()` gives the profile; the pin is on the
  relay profile).
- The scope is known synchronously from the URL (`isBoundBackendWindow()`), so key derivation
  can happen at store creation.
- Do not use a separate Electron partition just for storage: header injection relies on the
  window's session, and a partition would also split desktop preferences.

## Checks

- Formatting and lint (`bunx oxfmt`, `bunx oxlint`) on the 35 changed files: clean.
- Typecheck: `apps/web`, `apps/desktop` and `packages/contracts` pass.
- Web vitest (`src/rpc`, `src/lib`, `src/components/{sidebar,games,remote-backend}`): 163 files,
  1089 tests pass. This includes the new `backendScope.test.ts` and `backendScope.relay.test.ts`.
- Browser: `remoteBackendWindow.browser.tsx` (4 tests) and `-__root.startup.browser.tsx` pass.
- Desktop vitest (package): 134 files, 876 tests pass.
- Mutation checks: removing the bound routing in `getWsRpcClient`, the bound branch in
  `readNativeApi` or `resolveWsHttpOrigin`, the revision guidance, the asset origin check, or the
  role restriction on asset binding each makes a named test fail. The tests pass again once the
  code is restored.
- No server files changed.
