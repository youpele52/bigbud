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

### Orchestra

Use Orchestra when you want several AI agents to tackle different parts of the same job, either in parallel or as a sequenced handoff.

<iframe src="https://www.youtube-nocookie.com/embed/xuj5rBaKPVQ" title="bigbud: Orchestra"></iframe>

### Sidecar: keep a second conversation close

Open **Sidecar** from Quick actions when you need to explore an idea, ask a follow-up, or investigate something without leaving the thread you are working in. It floats above the composer, can be minimized while you work, and can be added back to the main chat as context when its findings matter.

![Sidecar floating above a main chat](https://assets.bigbud.app/content/sidecar.png)

### Keep tasks in view

Use the floating **Tasks** card to follow an agent's plan and its current progress without moving away from the conversation. Open it from Quick actions whenever you want to see what is underway, what comes next, or a proposed plan waiting for your review.

### Research without leaving your workspace

Open the **Browser** from the right side panel to keep a website beside your chat, files, notes, and terminal. You can read and work in the page yourself, or ask an agent to research it and bring the useful result back into the conversation.

### Writing notes like a Pro

Use notes to keep project context, drafts, and working memory close to your chats without jumping into a separate writing app.

<iframe src="https://www.youtube-nocookie.com/embed/DPceRqM3Sis" title="bigbud: Writing notes like a Pro"></iframe>

### Using bigbud's Kanban board

Use the Kanban board to turn loose ideas and agent work into visible tasks you can organize, revisit, and move through a workflow.

<iframe src="https://www.youtube-nocookie.com/embed/R0WvKJjY62Q" title="bigbud: Using bigbud's Kanban board"></iframe>

### Thread-aware agents: drag & drop context into AI

Drag threads into context when you want an agent to understand prior decisions or related work without pasting long transcripts by hand.

<iframe src="https://www.youtube-nocookie.com/embed/Y6cBo1jKA24" title="bigbud: Thread-aware agents — drag & drop threads into AI context"></iframe>

### Thread Reader Outline

Use the reader outline to jump through long conversations by user turn, keep your reading position, and return to the exact part of a thread that matters.

## Advanced Features

### Multi-agent orchestration with Orchestra

Orchestra coordinates multiple AI agents on one task, letting each player focus on a distinct role and run in parallel or as a sequenced handoff. Use it when a project benefits from different perspectives, specialized expertise, or a clear pass from one agent to the next; see the [Orchestra guide in Using bigbud](#orchestra) for the full workflow.

### Memory & Self-Improvement

bigbud can preserve useful preferences, confirmed knowledge, and project-specific context after successful work, so future conversations start with less repetition. Your personal, shared, and project memory stay separate, and any suggested improvement to a provider skill is shown as a patch for you to approve before it changes anything.

### Usage: understand where your tokens go

Open **Usage** from the sidebar to see token activity across providers and models. Review totals, trends, token mix, and the providers or models you use most, with plain-language explanations that make the numbers easier to interpret.

### Computer use: your agent, your extra hands

Your AI can now reach beyond the chat and work with your applications, your browser, and your desktop — clicking what you'd click, typing where you'd type, seeing what you see. Navigate a page, fill a form, write an email, book an appointment, check your calendar, open an app, grab a screenshot, run a diagnostic. All inside your session, all on your terms. Safety and security are built into the feature from the ground up — sensitive inputs are blocked before reaching the driver, and you control the limits in **Settings → AI → Computer use**.

Enable it in **Settings → AI → Computer use** and your agent becomes an extension of your workflow — macOS, Windows, or Linux.

#### Mobile Companion over Tailscale

Use Tailscale when your phone needs to reach the desktop backend away from the same local network.

1. Create a Tailscale account at [tailscale.com](https://tailscale.com/) and sign in with the same account on your laptop and phone.
2. Install Tailscale on the laptop running bigbud, then open Tailscale and confirm it says **Connected**.
3. Install Tailscale on your phone from the iOS App Store or Google Play, sign in to the same account, and confirm the phone is also **Connected**.
4. In the bigbud desktop app, open **Settings → Mobile Remote Control** and enable **Tailscale Serve**.
5. Copy or scan the mobile companion pairing link from that settings screen on your phone.
6. Keep the desktop app running. The phone connects through your private Tailnet, so prompts and responses can move between the mobile companion and the desktop session.

If the phone cannot connect, check that both devices are logged into the same Tailnet, Tailscale is connected on both devices, and **Tailscale Serve** is enabled in bigbud.
