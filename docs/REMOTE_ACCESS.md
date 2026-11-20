# Remote access to bigbud

This guide covers opening bigbud from another device. It is **not** the SSH-project workflow: [remote projects](../README.md#remote-projects) connect a local bigbud session to a remote workspace.

## Mobile companion

For phone access to the desktop backend, use the app's pairing flow rather than opening a bare server URL:

1. Install Tailscale on the computer running bigbud and on the phone, and sign both into the same Tailnet.
2. Keep bigbud running on the computer.
3. Open **Settings → Mobile Remote Control** and enable **Tailscale Serve**.
4. Copy or scan the pairing link shown by bigbud on the phone.
5. Follow the pairing flow. The mobile companion uses its own authenticated session at `/mobile-ws`; it does not use the desktop `/ws` token interchangeably.

### Tailscale Serve ports per channel

A computer has one Tailscale HTTPS name, so each bigbud channel serves on its own HTTPS port. That lets stable, prerelease and development builds be reachable at the same time:

| Build                                     | Tailscale Serve HTTPS port | Pairing address               |
| ----------------------------------------- | -------------------------- | ----------------------------- |
| bigbud (stable)                           | 443                        | `https://<host>.ts.net`       |
| bigbud beta                               | 8443                       | `https://<host>.ts.net:8443`  |
| bigbud preview                            | 9443                       | `https://<host>.ts.net:9443`  |
| bigbud nightly                            | 10443                      | `https://<host>.ts.net:10443` |
| Local development (`bun run dev:desktop`) | 10000                      | `https://<host>.ts.net:10000` |

The mapping lives in [`resolveTailscaleServeHttpsPort`](../packages/shared/src/desktopReleaseIdentity.ts). Stable keeps 443, so existing stable pairing links keep working. These ports are tailnet-only: Tailscale Serve accepts any HTTPS port, while Funnel (public internet exposure, which bigbud never enables) is limited to 443, 8443 and 10000.

Each channel only changes the `/` route on its own port and records that route in `tailscale-serve-owner.json` in its own data folder. Disabling Tailscale Serve turns off only that port, and only when bigbud's route is the only one on it. Routes on other ports, including other bigbud channels, are never changed.

### Take over a route left by another bigbud

If this channel's port already forwards `/` to a local port that this app did not set up, bigbud leaves it unchanged and explains why in Settings. When that local port belongs to another bigbud backend (for example an older stable build that predates route ownership records, or another channel), Settings shows **Take over**. bigbud identifies another bigbud from its backend lock file (`backend.lock` in that build's data folder), which records the backend's port. The lock counts only while that backend is running, or when nothing else is listening on its port any more.

Take over asks for confirmation, then replaces only that one `/` route on this channel's port. Phones paired with the other bigbud at that address stop reaching it until it is set up again. A route that forwards to anything else, such as another local service, is never taken over. Check `tailscale serve status` and remove that route yourself if you no longer need it.

The public walkthrough is in [the website's documentation source](../apps/marketing/src/components/page-specific/docs/_docs-content.md#mobile-companion-over-tailscale). Local development companion discovery is described in [Development commands](./development/scripts.md).

## Standalone server configuration

The server accepts CLI flags and environment variables. The [CLI configuration](../apps/server/src/cli/cli.config.ts) is authoritative; use `--help` for the full list.

| CLI flag                | Preferred environment variable | Compatibility alias   |
| ----------------------- | ------------------------------ | --------------------- |
| `--mode <web\|desktop>` | `BIGBUD_MODE`                  | `T3CODE_MODE`         |
| `--port <number>`       | `BIGBUD_PORT`                  | `T3CODE_PORT`         |
| `--host <address>`      | `BIGBUD_HOST`                  | `T3CODE_HOST`         |
| `--base-dir <path>`     | `BIGBUD_HOME`                  | `T3CODE_HOME`         |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL`          | none                  |
| `--no-browser`          | `BIGBUD_NO_BROWSER`            | `T3CODE_NO_BROWSER`   |
| `--auth-token <token>`  | `BIGBUD_AUTH_TOKEN`            | `T3CODE_AUTH_TOKEN`   |
| `--bootstrap-fd <fd>`   | `BIGBUD_BOOTSTRAP_FD`          | `T3CODE_BOOTSTRAP_FD` |

For example, after building, a backend can bind to its Tailscale IPv4 address:

```sh
bun run build
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$TAILNET_IP" --port 3773 --auth-token "$TOKEN" --no-browser
```

This starts an authenticated backend, **not a complete phone pairing flow**. The desktop/web RPC route requires the matching token in its WebSocket URL. Opening `http://<tailnet-ip>:3773` alone does not supply that token. The web client resolves its backend URL from the desktop bridge, a build-time `VITE_WS_URL`, or the page origin; it does not read a login token from the page's query string. See [URL resolution](../apps/web/src/lib/utils.ts) and [WebSocket admission](../apps/server/src/ws/ws.ts).

A custom web deployment must configure an authenticated client connection deliberately. A token embedded in a web build is visible to anyone who can download that build; it is not a secret authentication layer for a publicly served site. Do not disable backend authentication to work around a client-configuration problem. Prefer the supported mobile pairing flow for phones.

## Security

- Set an authentication token before exposing the standalone server outside loopback. The token does not provide TLS by itself.
- Prefer a trusted Tailnet or HTTPS deployment, and bind only to the required interface. `0.0.0.0` exposes all IPv4 interfaces and requires deliberate firewall controls.
- Treat tokens and pairing links as credentials. Do not publish them or commit them into source.
- When implementing a trusted process launcher, prefer the one-shot JSON bootstrap envelope on an inherited file descriptor (`--bootstrap-fd`) over putting its token in command-line arguments or environment variables.
- Mobile pairing/session admission is implemented separately from desktop RPC; see [mobile routes](../apps/server/src/ws/ws.mobile.ts).
