import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createZshQualification } from "./ZshSuggestions.pty";

// Actual foreground programs with synthetic disposable-HOME input only. This is
// neither arbitrary application/plugin qualification nor browser/OS IME evidence.
describe.skipIf(process.env.BIGBUD_ZSH_QUALIFICATION !== "1" || process.platform !== "darwin")(
  "zsh password and full-screen foreground envelope (NOT full G1/G2)",
  () => {
    it("passes accepting keys to a no-echo password read without leaking control or accepting history", async () => {
      const probe = await createZshQualification();
      try {
        await probe.grant();
        probe.write("print sentinel");
        await expect.poll(async () => (await probe.snapshot()).display).not.toBe("");
        probe.write(
          '\u0015IFS= read -r -s "reply?private password> "; print -r -- "$reply" > "$HOME/password-reply"\r',
        );
        await expect
          .poll(async () => (await probe.screen()).trimEnd())
          .toMatch(/private password>$/);
        expect((await probe.snapshot()).display).toBe("");
        const sequence = await probe.frame("suspend", 0);
        // ZLE's private control descriptor does not consume a foreground read's stdin.
        probe.write("fixture-secret\t\u001b[C\r");
        await expect
          .poll(() => readFile(join(probe.home, "password-reply"), "utf8"))
          .toBe("fixture-secret\t\u001b[C\n");
        await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
        expect(await probe.screen()).not.toContain("fixture-secret");
        expect(await probe.readStatus()).toMatch(new RegExp(` ${sequence} suspended \\d+\\n$`));
        await expect(readFile(join(probe.home, "executed"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await probe.dispose();
      }
    });

    it("never runs shell acceptance widgets while a real vi owns the alternate screen", async () => {
      const probe = await createZshQualification();
      try {
        await probe.grant();
        probe.write("print sentinel");
        await expect.poll(async () => (await probe.snapshot()).display).not.toBe("");
        // No user vimrc, viminfo, swap or workspace file. Absolute installed executable.
        probe.write('\u0015/usr/bin/vi -u NONE -i NONE -n "$HOME/editor-fixture"\r');
        await expect.poll(() => probe.isAlternateScreen()).toBe(true);
        expect((await probe.snapshot()).display).toBe("");
        const sequence = await probe.frame("suspend", 0);
        probe.write("\t\u001b[C");
        expect((await probe.snapshot()).accepts).toBe(0);
        expect((await probe.snapshot()).tabs + (await probe.snapshot()).rights).toBe(0);
        expect(await probe.readStatus()).toBe("");
        probe.write("\u001b:q!\r");
        await expect.poll(() => probe.isAlternateScreen()).toBe(false);
        await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
        expect(await probe.readStatus()).toMatch(new RegExp(` ${sequence} suspended \\d+\\n$`));
        await expect(readFile(join(probe.home, "executed"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(join(probe.home, "editor-fixture"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await probe.dispose();
      }
    });
  },
);
