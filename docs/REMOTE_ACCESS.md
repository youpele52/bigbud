# Remote access to bigbud

This guide covers opening bigbud from another device. It is **not** the SSH-project workflow: [remote projects](../README.md#remote-projects) connect a local bigbud session to a remote workspace.

## Mobile companion

For phone access to the desktop backend, use the app's pairing flow rather than opening a bare server URL:

1. Install Tailscale on the computer running bigbud and on the phone, and sign both into the same Tailnet.
2. Keep bigbud running on the computer.
3. Open **Settings → Mobile Remote Control** and enable **Tailscale Serve**.
4. Copy or scan the pairing link shown by bigbud on the phone.
5. Follow the pairing flow. The mobile companion uses its own authenticated session at `/mobile-ws`; it does not use the desktop `/ws` token interchangeably.

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
