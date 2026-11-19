import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fishScript } from "./shellIntegration.fish.ts";
import { bashScript, zshEnvScript } from "./shellIntegration.posix.ts";
import { installShellIntegration, shellIntegrationEnv } from "./shellIntegration.ts";

const scripts = {
  zsh: zshEnvScript(),
  bash: bashScript(". '/x/bash/bigbud.bash'"),
  fish: fishScript(),
};

describe("pane shell integration scripts", () => {
  it.each(Object.entries(scripts))(
    "%s emits only OSC 133 C/D and never touches the prompt",
    (_, script) => {
      const markers = [...script.matchAll(/033\]133;([A-Z])/g)].map((match) => match[1]);
      expect(new Set(markers)).toEqual(new Set(["C", "D"]));
      expect(script).not.toMatch(/\b(PS1|PROMPT|RPROMPT|fish_prompt)\s*=/);
      expect(script).not.toMatch(/function fish_prompt/);
    },
  );

  it.each(Object.entries(scripts))(
    "%s skips shells that already run a known integration",
    (_, script) => {
      expect(script).toContain("ITERM_SHELL_INTEGRATION_INSTALLED");
      expect(script).toContain("VSCODE_SHELL_INTEGRATION");
    },
  );

  it("zsh restores the user's ZDOTDIR before reading any user file", () => {
    const zsh = scripts.zsh;
    expect(zsh.indexOf('ZDOTDIR="$BIGBUD_ZSH_ZDOTDIR"')).toBeLessThan(zsh.indexOf("source"));
    expect(zsh).toContain("precmd_functions=(__bigbud_precmd $precmd_functions)");
  });

  it("bash never replaces an existing DEBUG trap or bash-preexec", () => {
    expect(scripts.bash).toContain('[[ -z "$(trap -p DEBUG)" && -z "$__bp_imported" ]]');
  });

  it("agent wrappers respect existing user functions and the hooks setting", () => {
    for (const script of [scripts.zsh, scripts.bash]) {
      expect(script).toMatch(/if ! (\(\( \$\{\+functions\[claude\]\} \)\)|declare -F claude)/);
      expect(script).toContain('command claude --settings "$BIGBUD_CLAUDE_HOOKS" "$@"');
      expect(script).toContain('command claude "$@"');
      expect(script).toContain("notify[[:space:]]*=");
    }
    expect(scripts.fish).toContain("if not functions -q claude");
  });
});

describe("installShellIntegration and shellIntegrationEnv", () => {
  it("installs content-addressed files and builds env without losing user values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bigbud-si-"));
    try {
      const files = await installShellIntegration(root);
      const again = await installShellIntegration(root);
      expect(again.dir).toBe(files.dir);
      const hooks = JSON.parse(await readFile(path.join(files.dir, "claude-hooks.json"), "utf8"));
      expect(hooks.hooks.Stop[0].hooks[0].command).toContain("terminalSequence");
      expect((await stat(path.join(files.dir, "codex-notify.sh"))).mode & 0o111).not.toBe(0);

      const env = shellIntegrationEnv(
        files,
        { ZDOTDIR: "/home/me/zsh", PROMPT_COMMAND: "history -a", XDG_DATA_DIRS: "/opt/share" },
        true,
      );
      expect(env.ZDOTDIR).toBe(path.join(files.dir, "zsh"));
      expect(env.BIGBUD_ZSH_ZDOTDIR).toBe("/home/me/zsh");
      expect(env.PROMPT_COMMAND).toBe(`${files.bootstrap}\nhistory -a`);
      expect(env.XDG_DATA_DIRS).toBe(`${path.join(files.dir, "fish")}:/opt/share`);
      expect(env.BIGBUD_TERMINAL_AGENT_HOOKS).toBe("1");
      expect(env.BIGBUD_CODEX_NOTIFY).toContain("codex-notify.sh");

      const off = shellIntegrationEnv(files, {}, false);
      expect(off.BIGBUD_TERMINAL_AGENT_HOOKS).toBeUndefined();
      expect(off.BIGBUD_ZSH_ZDOTDIR).toBeUndefined();
      expect(off.PROMPT_COMMAND).toBe(files.bootstrap);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
