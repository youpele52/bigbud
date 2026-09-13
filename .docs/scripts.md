# Scripts

- `bun run dev` — Starts contracts, server, web, and mobile companion in `turbo watch` mode.
- `bun run dev:server` — Starts just the WebSocket server (uses Bun TypeScript execution).
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- `bun run dev:mobile-web` — Starts just the mobile companion Vite dev server.
- Dev commands default `BIGBUD_HOME` to `~/.bigbud` unless overridden.
- Override server CLI-equivalent flags from root dev commands with `--`, for example:
  `bun run dev -- --base-dir ~/.bigbud-2`
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.
- `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch.
- `bun run dist:desktop:dmg` — Builds a shareable macOS `.dmg` into `./release`.
- `bun run dist:desktop:dmg:x64` — Builds an Intel macOS `.dmg`.
- `bun run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `bun run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/macos-icon-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `t3://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `bun run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple dev instances

Set `BIGBUD_DEV_INSTANCE` to any value to deterministically shift all dev ports together. Legacy `T3CODE_DEV_INSTANCE` is still accepted.

Base ports (offset `0`):

- Server: `3773` (`BIGBUD_PORT`)
- Web: `5733` (`PORT`)
- Mobile web: `5740` (`MOBILE_WEB_PORT`)

The instance offset is used as the starting point for all three ports. Each development mode only shifts the ports it launches. The mobile companion starts at `5740 + offset`, retries occupied ports when binding, and skips the sibling web port and active workspace reservations. Its startup output reports its actual listening port. The offset is hashed from `BIGBUD_DEV_INSTANCE` unless you provide a numeric instance value.

Root development commands and the direct web/mobile package `dev` commands coordinate port allocation across all instance offsets in the same canonical checkout. A short filesystem mutex protects web selection plus reservation, and mobile reservation checks plus bind and discovery publication. Cargo builds run before final selection; the mutex is never held while Cargo or Turbo runs. Web reservations remain active for the Vite process lifetime, protecting delayed startup and restarts. Each launcher owns a unique reservation; Vite runs in the same process that owns its attachment, so it remains protected if the runner exits and cannot outlive its reservation owner. Runner/mobile shutdown releases owned records; process-lifetime Vite reservations and other confirmed-dead process records are recovered on the next allocation. Old timestamps or failed health probes never authorize stealing a live reservation.

Coordination state is ephemeral, per-user OS temporary data, not app userdata or a database. Uncertain or malformed ownership fails closed with a startup error. This guarantee covers cooperating commands from this checkout on the local filesystem; it cannot reserve an unbound TCP port against unrelated external software or bare `vite` invocations. Direct web `dev` retains Vite CLI options, but enforces its selected port with strict binding so the renderer/backend URL cannot silently diverge.

In development, **Remote settings → Mobile app URL → Local** discovers a running companion from the same checkout and instance. Separate `dev:web` and `dev:mobile-web` commands share discovery; when multiple companions are running, the lowest verified port is selected. Local uses the exact verified address (`http://127.0.0.1:<port>` or `http://[::1]:<port>`) so `localhost` cannot resolve to a different service. Settings refresh discovery and verify it again before creating a Local pairing link. When no companion is reachable, Local pairing is unavailable instead of falling back to a guessed port.

Automatic Local pairing supports the app's `/` and `/mobile/` bases and loopback-accessible listeners. Other bases or non-loopback-only host bindings produce an explicit development diagnostic instead of an automatic link. The direct mobile package launcher preserves `--port`, `--host`, `--mode`, `--open`, `--force`, `--cors`, `--base`, `--config`, `--logLevel`, and clear-screen controls; unsupported advanced Vite flags or positional roots are rejected explicitly (`bun run --cwd apps/mobile-web dev --help` lists supported options).

Typing a URL selects Custom. Saved custom URLs, including localhost and LAN addresses, are preserved rather than rewritten when development ports or the Tailscale backend change. Existing saved URLs are retained; select Local explicitly to use automatic discovery. The hosted bigbud companion remains available. A localhost link works on the development computer only; phone access still requires a phone-reachable companion origin and backend URL.

Examples:

```bash
BIGBUD_DEV_INSTANCE=branch-a bun run dev
BIGBUD_DEV_INSTANCE=branch-a bun run dev:mobile-web
```

If you want full control instead of hashing, set `BIGBUD_PORT_OFFSET` to a numeric offset. Legacy `T3CODE_PORT_OFFSET` is still accepted.

The dev runner prints the selected server/web ports and the mobile starting port on startup:

```text
[dev-runner] mode=dev source=... serverPort=3773 webPort=5733 mobileStartPort=5740 baseDir=...
```
