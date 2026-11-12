import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createZshQualification } from "./ZshSuggestions.pty";

describe.skipIf(process.env.BIGBUD_ZSH_QUALIFICATION !== "1" || process.platform !== "darwin")(
  "controlled zsh startup/rendering envelope (NOT arbitrary rc or browser qualification)",
  () => {
    it.each([false, true])("loads disposable startup files once, login=%j", async (login) => {
      const startup = Object.fromEntries(
        [".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((name) => [
          name,
          `print -r -- ${name} >> "$HOME/startup-order"`,
        ]),
      );
      const probe = await createZshQualification({ login, startup });
      try {
        expect(probe.available).toBe(true);
        expect(await readFile(join(probe.home, "startup-order"), "utf8")).toBe(
          login ? ".zshenv\n.zprofile\n.zshrc\n.zlogin\n" : ".zshenv\n.zshrc\n",
        );
      } finally {
        await probe.dispose();
      }
    });

    it.each([
      "custom_tab() { print -r -- tab > \"$HOME/original\"; }; zle -N custom_tab; bindkey '^I' custom_tab",
      "custom_right() { print -r -- right > \"$HOME/original\"; }; zle -N custom_right; bindkey '^[[C' custom_right",
      "_zsh_autosuggest_start() { :; }; POSTDISPLAY='native suffix'",
      "native_hook() { :; }; zle -N zle-line-pre-redraw native_hook",
      "bindkey -v",
    ])("declines conflicting customization without claiming widget ownership (%#)", async (rc) => {
      const probe = await createZshQualification({ startup: { ".zshrc": rc } });
      try {
        expect(probe.available).toBe(false);
        probe.write("\t\u001b[C");
        if (rc.startsWith("custom_")) {
          await expect
            .poll(() => readFile(join(probe.home, "original"), "utf8"))
            .toMatch(/tab|right/);
        }
        // Ordinary shell execution still works; the adapter did not replace the bindings.
        probe.write('\u0015print -r -- usable > "$HOME/usable"\r');
        await expect.poll(() => readFile(join(probe.home, "usable"), "utf8")).toBe("usable\n");
      } finally {
        await probe.dispose();
      }
    });

    it("renders spaced decoration through headless xterm at narrow width and after resize", async () => {
      const probe = await createZshQualification({ cols: 24 });
      try {
        await probe.grant();
        probe.write("print uni");
        await expect.poll(async () => (await probe.snapshot()).display).toBe("code-λ  →");
        await expect
          .poll(async () => (await probe.screen()).replaceAll("\n", ""))
          .toContain("print unicode-λ  →");
        probe.resize(60);
        await expect.poll(() => probe.screen()).toContain("print unicode-λ  →");
        probe.write("\u001b[C");
        await expect.poll(async () => (await probe.snapshot()).accepts).toBe(1);
        expect((await probe.snapshot()).buffer).toBe("print unicode-λ");
        await expect.poll(async () => (await probe.screen()).includes("→")).toBe(false);
      } finally {
        await probe.dispose();
      }
    });

    it("does not execute literal punctuation until a separate Enter", async () => {
      const probe = await createZshQualification();
      try {
        await probe.grant();
        probe.write("print sentinel");
        await expect.poll(async () => (await probe.snapshot()).display).not.toBe("");
        probe.write("\t");
        await expect.poll(async () => (await probe.snapshot()).accepts).toBe(1);
        await expect(readFile(join(probe.home, "executed"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect((await probe.snapshot()).buffer).not.toContain("→");
        probe.write("\r");
        await expect.poll(() => readFile(join(probe.home, "executed"), "utf8")).toBe("executed\n");
      } finally {
        await probe.dispose();
      }
    });

    it("checks current buffer even when a widget mutates it and accepts without redraw", async () => {
      const probe = await createZshQualification({
        startup: {
          ".zshrc":
            "mutate() { BUFFER='print uni'; CURSOR=${#BUFFER}; zle q_tab; }; zle -N mutate; bindkey '^X' mutate",
        },
      });
      try {
        await probe.grant();
        probe.write("print -r");
        await expect.poll(async () => (await probe.snapshot()).display).not.toBe("");
        probe.write("\u0018");
        await expect.poll(async () => (await probe.snapshot()).tabs).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
      } finally {
        await probe.dispose();
      }
    });
  },
);
