# Docs

## Getting started

install bigbud on your machine, set up your AI providers, launch the app, and start your first session. no terminal needed — everything works from the app.

### 1. Download and install

bigbud runs on macOS, Windows, and Linux.

**[Download the latest version](/download)** — the installer will walk you through setup in a few clicks.

### 2. Set up your AI providers

bigbud works with the AI providers you already use. if you don't have an account yet, download and sign up for one or more of these providers:

- **[Claude](https://claude.ai/download)** — download the desktop app, sign in, and subscribe if needed
- **[Codex](https://chatgpt.com/codex/)** — install the CLI and sign in with your account
- **[GitHub Copilot](https://github.com/features/copilot)** — install the extension and sign in with your GitHub account
- **[OpenCode](https://opencode.ai)** — install the CLI and authenticate

once you have your provider accounts ready:

1. **open bigbud** — it will automatically detect installed providers on your machine
2. bigbud performs a **handshake** with each provider, verifying your subscription
3. your available **models** from each provider appear in the provider picker

you can connect multiple providers and switch between them as needed. bigbud shows you which models are available from each subscription, so you always know what you have access to.

### 3. Launch the app

open bigbud from your applications folder (or start menu on Windows). you'll see your workspace — a clean window with a sidebar on the left, the main area in the center, and tools on the right.

### 4. Start a thread

press `Cmd + N` (macOS) or `Ctrl + N` (Windows/Linux) to start a new thread. type your question or task in the input at the bottom and press enter. bigbud will respond using your connected provider.

you can switch providers mid-thread using the provider picker at the top of the input area. threads are organized in the sidebar — rename them, switch between them, or archive them as you go.

### 5. Explore your workspace

bigbud brings everything into one window. here are the key areas to know:

**Left side panel** — your navigation hub. browse your **Projects**, jump back into recent **Chats**, trigger **Automations**, and pin **Favorite threads** for quick access.

**Chat** — the main area where you talk to your AI providers. type a question, paste code, or describe what you need. the provider responds inline, and the conversation stays in the thread.

**Right side panel** — use the right panel to view and work with your own files, write notes, browse the web, and more without leaving your chat. press `Cmd + T` (macOS) or `Ctrl + T` (Windows/Linux) to open the panel switcher and choose from:

- **Files** — browse and open project files
- **Notes** — write markdown notes
- **Browser** — open a website alongside your workspace
- **Terminal** — start an interactive shell
- **Diff** — view code changes side by side
- **Kanban** — track work across columns
- **Git** — inspect repo changes

**Search** — find anything fast:

- `Cmd + F` / `Ctrl + F` — search across your threads
- `Cmd + P` / `Ctrl + P` — search files, folders, and commands

### 6. Keyboard shortcuts

| macOS                                 | Windows/Linux                           | action                         |
| ------------------------------------- | --------------------------------------- | ------------------------------ |
| `Cmd + B`                             | `Ctrl + B`                              | toggle sidebar                 |
| `Cmd + T`                             | `Ctrl + T`                              | open right side panel switcher |
| `Cmd + N`                             | `Ctrl + N`                              | new thread                     |
| `Cmd + ,`                             | `Ctrl + ,`                              | open settings                  |
| `Cmd + F`                             | `Ctrl + F`                              | search threads                 |
| `Cmd + P`                             | `Ctrl + P`                              | search files & commands        |
| `Cmd + J`                             | `Ctrl + J`                              | toggle terminal                |
| `Cmd + Shift + G`                     | `Ctrl + Shift + G`                      | toggle diff bar                |
| `Cmd + Shift + B`                     | `Ctrl + Shift + B`                      | toggle browser panel           |
| `Cmd + Shift + E`                     | `Ctrl + Shift + E`                      | toggle files panel             |
| `Cmd + Shift + N`                     | `Ctrl + Shift + N`                      | new local thread               |
| `Cmd + Shift + [` / `Cmd + Shift + ]` | `Ctrl + Shift + [` / `Ctrl + Shift + ]` | previous / next thread         |

these shortcuts live in [`apps/server/src/keybindings/keybindings.ts`](https://github.com/youpele52/bigbud/blob/main/apps/server/src/keybindings/keybindings.ts) — feel free to edit them yourself, or tell the agent in bigbud to do it.

### 7. Next steps

- **[read the changelog](/changelog)** — see what's new in each release
- **[join the community](https://x.com/bigbudapp)** — share feedback, ideas, and feature requests

## Using bigbud

### Writing notes like a Pro

<iframe src="https://www.youtube-nocookie.com/embed/DPceRqM3Sis" title="bigbud: Writing notes like a Pro"></iframe>
