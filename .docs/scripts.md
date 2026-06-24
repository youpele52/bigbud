# Scripts

- `bun run dev` — Starts contracts, server, and web in `turbo watch` mode.
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

Shifted ports use the same offset for all three: `base + offset`. The offset is hashed from `BIGBUD_DEV_INSTANCE` unless you provide a numeric instance value.

Examples:

```bash
BIGBUD_DEV_INSTANCE=branch-a bun run dev
BIGBUD_DEV_INSTANCE=branch-a bun run dev:mobile-web
```

If you want full control instead of hashing, set `BIGBUD_PORT_OFFSET` to a numeric offset. Legacy `T3CODE_PORT_OFFSET` is still accepted.

The dev runner prints the resolved ports on startup:

```text
[dev-runner] mode=dev source=... serverPort=3773 webPort=5733 mobileWebPort=5740 baseDir=...
```
