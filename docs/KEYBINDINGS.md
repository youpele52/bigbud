# Keybindings

bigbud stores custom keybindings at `<stateDir>/keybindings.json`. The default packaged-server path is `~/.bigbud/userdata/keybindings.json`; development uses `~/.bigbud/dev/keybindings.json`. A custom `BIGBUD_HOME` or release-channel identity changes the base directory. See [release identity and data isolation](./development/release.md#side-by-side-identity-and-data-isolation).

The file is a JSON array of rules, for example:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

These are example overrides, not the defaults. The server merges custom rules with defaults, backfills missing default commands on startup, and reports configuration issues. See the [schema](../packages/contracts/src/server/keybindings.ts) and [configuration service](../apps/server/src/keybindings/keybindings.ts).

## Defaults

`mod` is `Cmd` on macOS and `Ctrl` on Windows/Linux. Focus-specific rules let the same shortcut do different things inside and outside a terminal.

| Shortcut          | Command                           | Default context  |
| ----------------- | --------------------------------- | ---------------- |
| `mod+j`           | `terminal.toggle`                 | Any              |
| `mod+shift+j`     | `terminalPanel.toggle`            | Any              |
| `mod+b`           | `sidebar.toggle`                  | Any              |
| `mod+,`           | `settings.toggle`                 | Any              |
| `mod+f`           | `search.toggle`                   | Outside terminal |
| `mod+f`           | `terminal.find`                   | Terminal focused |
| `mod+shift+g`     | `terminal.split`                  | Terminal focused |
| `mod+n`           | `terminal.new`                    | Terminal focused |
| `mod+w`           | `terminal.close`                  | Terminal focused |
| `mod+w`           | `rightPanel.closeTab`             | Outside terminal |
| `mod+g`           | `git.toggle`                      | Outside terminal |
| `mod+shift+g`     | `diff.toggle`                     | Outside terminal |
| `mod+shift+b`     | `browser.toggle`                  | Outside terminal |
| `mod+shift+e`     | `files.toggle`                    | Outside terminal |
| `alt+mod+b`       | `rightPanel.toggle`               | Outside terminal |
| `mod+t`           | `rightPanel.newTab`               | Outside terminal |
| `mod+p`           | `commandPalette.toggle`           | Outside terminal |
| `mod+l`           | `chat.focus`                      | Outside terminal |
| `mod+n`           | `chat.new`                        | Outside terminal |
| `mod+alt+n`       | `chat.newLocal`                   | Outside terminal |
| `mod+shift+n`     | `notes.toggle`                    | Outside terminal |
| `mod+shift+s`     | `sidecar.toggle`                  | Outside terminal |
| `mod+shift+t`     | `planCard.toggle`                 | Outside terminal |
| `mod+o`           | `project.open`                    | Outside terminal |
| `mod+shift+o`     | `editor.openFavorite`             | Outside terminal |
| `mod+shift+[`     | `thread.previous`                 | Any              |
| `mod+shift+]`     | `thread.next`                     | Any              |
| `mod+1` … `mod+9` | `thread.jump.1` … `thread.jump.9` | Any              |

The authoritative defaults are [`DEFAULT_KEYBINDINGS`](../apps/server/src/keybindings/keybindings.ts). Existing user overrides can differ from these defaults.

## Available commands

- `terminal.toggle`, `terminalPanel.toggle`: toggle the terminal drawer or terminal panel.
- `terminal.split`, `terminal.new`, `terminal.close`, `terminal.find`: split, create, close, or search a terminal.
- `git.toggle`, `diff.toggle`, `browser.toggle`, `files.toggle`, `notes.toggle`: toggle the corresponding workspace panel.
- `rightPanel.toggle`, `rightPanel.newTab`, `rightPanel.closeTab`: toggle the right panel, open its panel switcher, or close its active tab.
- `commandPalette.toggle`, `sidebar.toggle`, `settings.toggle`, `search.toggle`: toggle the corresponding interface.
- `chat.focus`: focus the chat composer.
- `chat.new`: create a chat preserving the active thread's branch/worktree context.
- `chat.newLocal`: create a chat in a new environment according to the app's local/worktree preference.
- `sidecar.toggle`, `planCard.toggle`: toggle Sidecar or the floating Tasks/Plan card.
- `project.open`: open the project picker.
- `editor.openFavorite`: open the active workspace in the preferred editor.
- `thread.previous`, `thread.next`, `thread.jump.1` … `thread.jump.9`: navigate sidebar threads.
- `script.{id}.run`: run a project script, for example `script.test.run`.

## Rule shape and key syntax

- `key` (required): a shortcut such as `mod+j`, `ctrl+k`, or `cmd+shift+d`.
- `command` (required): an action ID from the schema.
- `when` (optional): a boolean expression controlling when the shortcut is active.

Supported modifiers include `mod`, `cmd`/`meta`, `ctrl`/`control`, `shift`, and `alt`/`option`.

## Conditions and precedence

Available context keys are `terminalFocus` and `terminalOpen`. Expressions support `!`, `&&`, `||`, and parentheses. Unknown condition keys evaluate to `false`.

Examples:

- `"terminalFocus"`
- `"terminalOpen && !terminalFocus"`
- `"terminalFocus || terminalOpen"`

The last matching active rule wins, including when several commands use the same key. See the [compiler](../apps/server/src/keybindings/keybindings.compiler.ts) for validation and default-merge behavior.
