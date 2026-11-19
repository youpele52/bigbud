import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TERMINAL_AGENT_DONE_MARKER } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { fishScript } from "./shellIntegration.fish.ts";
import { bashScript, shellQuote, zshEnvScript } from "./shellIntegration.posix.ts";

/** Claude Code hooks run without a controlling terminal; `terminalSequence` is emitted for them. */
export const CLAUDE_HOOKS_SETTINGS = {
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `printf '%s' ${shellQuote(JSON.stringify({ terminalSequence: TERMINAL_AGENT_DONE_MARKER }))}`,
          },
        ],
      },
    ],
  },
} as const;

export const CODEX_NOTIFY_SCRIPT = `#!/bin/sh
# bigbud: Codex notify hook. Marks the pane's turn finished; carries no content.
printf '\\033]777;bigbud;done\\007' > /dev/tty 2>/dev/null || true
`;

export interface ShellIntegrationFiles {
  readonly dir: string;
  readonly bootstrap: string;
}

function integrationFiles(dir: string): Record<string, string> {
  const bootstrap = `. ${shellQuote(path.join(dir, "bash", "bigbud.bash"))}`;
  return {
    [path.join("zsh", ".zshenv")]: zshEnvScript(),
    [path.join("bash", "bigbud.bash")]: bashScript(bootstrap),
    [path.join("fish", "fish", "vendor_conf.d", "bigbud.fish")]: fishScript(),
    ["claude-hooks.json"]: `${JSON.stringify(CLAUDE_HOOKS_SETTINGS, null, 2)}\n`,
    ["codex-notify.sh"]: CODEX_NOTIFY_SCRIPT,
  };
}

/** Writes the integration under `<root>/<content hash>/`, atomically and only when missing. */
export async function installShellIntegration(root: string): Promise<ShellIntegrationFiles> {
  const probe = integrationFiles("<dir>");
  const version = createHash("sha256").update(JSON.stringify(probe)).digest("hex").slice(0, 12);
  const dir = path.join(root, version);
  const files = integrationFiles(dir);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    const existing = await readFile(target, "utf8").catch(() => null);
    if (existing === content) continue;
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: relative.endsWith(".sh") ? 0o755 : 0o644 });
    await rename(temporary, target);
  }
  return { dir, bootstrap: `. ${shellQuote(path.join(dir, "bash", "bigbud.bash"))}` };
}

/**
 * Environment that enables the integration in a local POSIX pane. Only environment variables:
 * no shell arguments, user files or prompt text change. The user's own ZDOTDIR,
 * PROMPT_COMMAND and XDG_DATA_DIRS are preserved and restored by the scripts.
 */
export function shellIntegrationEnv(
  files: ShellIntegrationFiles,
  base: Readonly<Record<string, string | undefined>>,
  agentHooks: boolean,
): Record<string, string> {
  const fishData = path.join(files.dir, "fish");
  const env: Record<string, string> = {
    BIGBUD_SHELL_INTEGRATION_DIR: files.dir,
    ZDOTDIR: path.join(files.dir, "zsh"),
    PROMPT_COMMAND: base.PROMPT_COMMAND
      ? `${files.bootstrap}\n${base.PROMPT_COMMAND}`
      : files.bootstrap,
    BIGBUD_FISH_DATA_DIR: fishData,
    XDG_DATA_DIRS: [fishData, base.XDG_DATA_DIRS || "/usr/local/share:/usr/share"].join(":"),
  };
  if (base.ZDOTDIR !== undefined) env.BIGBUD_ZSH_ZDOTDIR = base.ZDOTDIR;
  if (agentHooks) {
    env.BIGBUD_TERMINAL_AGENT_HOOKS = "1";
    env.BIGBUD_CLAUDE_HOOKS = path.join(files.dir, "claude-hooks.json");
    const notify = path.join(files.dir, "codex-notify.sh");
    // A TOML basic string cannot hold these without escaping; skip Codex injection then.
    if (!/["\\\n]/.test(notify)) env.BIGBUD_CODEX_NOTIFY = `["sh", "${notify}"]`;
  }
  return env;
}
