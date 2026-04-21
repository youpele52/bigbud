# bigbud

<p align="center">
  <img src="apps/desktop/resources/icon.png" alt="bigbud logo" width="80">
</p>

An AI companion workspace for getting things done — whether you're coding, writing, analyzing, or exploring ideas. Built for developers and designed for everyone.

> **About the name:** This project was formally known as **bigCode** ([https://github.com/youpele52/bigCode](https://github.com/youpele52/bigCode)). The rebranding to **bigbud** reflects our evolved vision: while we excel at coding tasks, we're expanding to help anyone accomplish their goals. Like a good friend, bigbud is here to be useful to everyone — programmers and non-programmers alike.
>
> _Note:_ The original bigCode repository was either hacked or DMCA'd — while the page returns a 404, its Actions and Settings pages are still accessible.

## Features

- **Multi-provider support** — Switch between Codex, Claude, Copilot, OpenCode, Pi, Cursor, and more
- **Desktop & Web** — Native Electron desktop app or lightweight web UI
- **Real-time streaming** — Live output with file changes, terminal commands, and reasoning
- **Full access mode** — Auto-approve commands and file edits for autonomous coding
- **Built-in terminal** — Integrated shell access alongside your agent conversations
- **Chat threads** — Have normal conversations with any agent without starting a new project
- **System control** — Tell agents to execute commands and perform tasks on your PC/Mac
- **Thread forking** — Switch providers or harnesses mid-conversation to compare responses

<p align="center">
  <img src="docs/images/screenshot-chat.png" alt="bigbud Chat Interface" width="100%" />
</p>

## Quick Install

### Desktop App

#### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/youpele52/bigbud/main/apps/marketing/public/install.sh | sh
```

#### Windows

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/youpele52/bigbud/main/apps/marketing/public/install.ps1 | iex"
```

Or download directly from [GitHub Releases](https://github.com/youpele52/bigbud/releases).

### From Source

```bash
git clone https://github.com/youpele52/bigbud.git
cd bigbud
bun install
bun dev
```

Open [`http://localhost:5733`](http://localhost:5733) in your browser.

For desktop development:

```bash
bun dev:desktop
```

## Provider Setup

bigbud supports multiple AI coding agents. Configure at least one in **Settings → Providers**:

| Provider     | Setup                                                                               |
| ------------ | ----------------------------------------------------------------------------------- |
| **Claude**   | Install Claude Code: `npm i -g @anthropic-ai/claude-code`, then `claude auth login` |
| **Copilot**  | Authenticate via GitHub CLI: `gh auth login`                                        |
| **Codex**    | Install Codex CLI and run `codex login`                                             |
| **OpenCode** | See [OpenCode docs](https://opencode.ai)                                            |
| **Pi**       | Bundled — no additional setup needed                                                |
| **Cursor**   | Install [Cursor](https://cursor.sh)                                                 |

Provider status is checked in real-time and displayed in Settings. Each provider can be toggled on or off independently.

<p align="center">
  <img src="docs/images/screenshot-settings.png" alt="bigbud Provider Settings" width="100%" />
</p>

## Desktop vs Web

|                     | Desktop                       | Web                       |
| ------------------- | ----------------------------- | ------------------------- |
| **Installation**    | Native installer              | `bun dev` or self-hosted  |
| **Server**          | Bundled — runs locally        | Requires separate server  |
| **Native features** | OS notifications, system tray | Browser-based only        |
| **Best for**        | Everyday use                  | Development, self-hosting |

## Documentation

- [AGENTS.md](./AGENTS.md) — Development guide
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines
- [docs/release.md](./docs/release.md) — Release workflow & signing
- [docs/observability.md](./docs/observability.md) — Observability setup

## Development

```bash
# Full dev stack (server + web)
bun dev

# Individual apps
bun dev:server
bun dev:web
bun dev:desktop

# Run checks
bun fmt
bun lint
bun typecheck
bun run test   # Use this, not "bun test"
```

### Desktop Packaging

```bash
bun dist:desktop:dmg:arm64   # macOS Apple Silicon
bun dist:desktop:dmg:x64     # macOS Intel
bun dist:desktop:linux       # Linux AppImage
bun dist:desktop:win         # Windows NSIS installer
```

## Status

Early alpha — expect breaking changes.

We're not accepting contributions yet. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.
