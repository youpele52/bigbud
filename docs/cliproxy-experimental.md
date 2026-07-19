# CLIProxy experimental integration

CLIProxy is disabled by default. Enable it only for a proxy you operate on the
local machine:

```sh
BIGBUD_EXPERIMENTAL_CLIPROXY=1
BIGBUD_CLIPROXY_BASE_URL=http://127.0.0.1:8317
BIGBUD_CLIPROXY_API_KEY=...
BIGBUD_CLIPROXY_MANAGEMENT_KEY=...
```

The integration never writes these values, manages the proxy, runs Codex, or
changes native Codex/Claude settings. Values are read from the process
environment only. The proxy URL must resolve to `localhost`, `127.0.0.1`, or
`::1`.

Desktop launches hydrate missing CLIProxy values from the login shell on macOS
and Linux. Restart bigbud after changing them. CLIProxy uses an isolated Claude
Code SDK harness with an empty Claude settings source list and a newly built
proxy environment. Claude Code must be available on `PATH`; Codex is never
invoked. One authenticated proxy source with models is sufficient. Only
interactive threads are supported; text generation, learning, and handoff
workflows must continue to use native providers.

## Removal manifest and compatibility

`cliProxy` is a historical provider identity in contracts so persisted event
payloads remain decodable after executable support is removed. Runtime code is
contained in `apps/server/src/provider/Services/CliProxy` and
`apps/server/src/provider/Layers/CliProxy`.

The only integration points outside those directories are explicit `cliProxy`
branches in the server registration/session gate, Turbo environment allowlist,
desktop login-shell environment list, and web model-selection helpers. Each is
marked as an experiment boundary and can be deleted with the runtime code; none
changes the behavior of another provider. Retain the `cliProxy` contract literal
and historical decoder entries. Old cliProxy sessions intentionally do not
recover once runtime support is removed.
