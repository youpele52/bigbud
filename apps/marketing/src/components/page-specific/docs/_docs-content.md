# Docs

Every panel and shortcut in bigbud exists to keep you from switching windows. Install, connect your providers, and learn how the workspace adapts to the way you'd like to work.

## Getting started

Install bigbud on your machine, set up your AI providers, launch the app, and start your first session. No terminal needed — everything works from the app.

### 1. Download and install

bigbud runs on macOS, Windows, and Linux.

**[Download the latest version](/download)** — The installer will walk you through setup in a few clicks.

### 2. Set up your AI providers

bigbud works with the AI providers you already use. If you don't have an account yet, download and sign up for one or more of these providers:

- **[Claude](https://claude.ai/download)** — Download the desktop app, sign in, and subscribe if needed
- **[Codex](https://chatgpt.com/codex/)** — Install the CLI and sign in with your account
- **[GitHub Copilot](https://github.com/features/copilot)** — Install the extension and sign in with your GitHub account
- **[OpenCode](https://opencode.ai)** — Install the CLI and authenticate

Once you have your provider accounts ready:

1. **Open bigbud** — it will automatically detect installed providers on your machine
2. bigbud performs a **handshake** with each provider, verifying your subscription
3. Your available **models** from each provider appear in the provider picker

You can connect multiple providers and switch between them as needed. bigbud shows you which models are available from each subscription, so you always know what you have access to.

### 3. Launch the app

Open bigbud from your applications folder (or start menu on Windows). You'll see your workspace — a clean window with a sidebar on the left, the main area in the center, and tools on the right.

### 4. Start a thread

Press `Cmd + N` (macOS) or `Ctrl + N` (Windows/Linux) to start a new thread. Type your question or task in the input at the bottom and press enter. bigbud will respond using your connected provider.

You can switch providers mid-thread using the provider picker at the top of the input area. Threads are organized in the sidebar — rename them, switch between them, or archive them as you go.

### 5. Explore your workspace

bigbud brings everything into one window. Here are the key areas to know:

**Left side panel** — your navigation hub. Browse your **Projects**, jump back into recent **Chats**, trigger **Automations**, and pin **Favorite threads** for quick access.

**Chat** — the main area where you talk to your AI providers. Type a question, paste code, or describe what you need. The provider responds inline, and the conversation stays in the thread.

**Right side panel** — Use the right panel to view and work with your own files, write notes, browse the web, and more without leaving your chat. Press `Cmd + T` (macOS) or `Ctrl + T` (Windows/Linux) to open the panel switcher and choose from:

- **Files** — Browse and open project files (including inline video preview for `.mp4`, `.webm`, `.mov`, `.avi`)
- **Notes** — Write markdown notes
- **Browser** — Open a website alongside your workspace
- **Terminal** — Start an interactive shell
- **Diff** — View code changes side by side
- **Kanban** — Track work across columns
- **Git** — Inspect repo changes

Press `Cmd + W` / `Ctrl + W` to close the active right-panel tab.

**Search** — Find anything fast:

- `Cmd + F` / `Ctrl + F` — Search across your threads
- `Cmd + P` / `Ctrl + P` — Search files, folders, and commands

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
| `Cmd + W`                             | `Ctrl + W`                              | close active right panel tab   |
| `Cmd + Shift + [` / `Cmd + Shift + ]` | `Ctrl + Shift + [` / `Ctrl + Shift + ]` | previous / next thread         |

### 7. Next steps

- **[Read the changelog](/changelog)** — see what's new in each release
- **[Join the community](https://x.com/bigbudapp)** — share feedback, ideas, and feature requests

## Using bigbud

### Writing notes like a Pro

<iframe src="https://www.youtube-nocookie.com/embed/DPceRqM3Sis" title="bigbud: Writing notes like a Pro"></iframe>

### Using bigbud's Kanban board

<iframe src="https://www.youtube-nocookie.com/embed/R0WvKJjY62Q" title="bigbud: Using bigbud's Kanban board"></iframe>

### Thread-aware agents: drag & drop context into AI

<iframe src="https://www.youtube-nocookie.com/embed/Y6cBo1jKA24" title="bigbud: Thread-aware agents — drag & drop threads into AI context"></iframe>

### Computer Use: desktop and browser automation

AI agents can now control the in-app browser and, on desktop, your macOS machine. Enable desktop automation in **Settings → AI → Computer Use**, grant macOS Accessibility and Screen Recording permissions, and your agents can navigate the web, fill forms, open apps, take screenshots, and more — all within your session. Mutating actions (click, type, key presses) require `full-access` mode; read-only actions (capture, list windows, diagnostics) work in any mode.
