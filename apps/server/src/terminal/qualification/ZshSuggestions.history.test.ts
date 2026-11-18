import { describe, expect, it } from "vitest";
import { createZshQualification } from "./ZshSuggestions.pty";

describe.skipIf(process.env.BIGBUD_ZSH_QUALIFICATION !== "1" || process.platform !== "darwin")(
  "bounded synthetic shell history and buffer filtering",
  () => {
    it.each([
      "\\0",
      "\\r",
      "\\n",
      "\\t",
      "\\e",
      "\\x7f",
      "\\u009f",
      "\\u2028",
      "\\u2029",
      "\\u202e",
      "\\u2066",
      "\\ufeff",
      "\\U000e0020",
    ])("rejects history containing %s without sanitizing it", async (control) => {
      const probe = await createZshQualification({
        startup: { ".zshrc": `print -s -- $'probe unsafe${control}hidden'` },
      });
      try {
        await probe.grant();
        probe.write("probe unsafe");
        await expect.poll(async () => (await probe.snapshot()).buffer).toBe("probe unsafe");
        expect((await probe.snapshot()).display).toBe("");
        probe.write("\u001b[C");
        await expect.poll(async () => (await probe.snapshot()).rights).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
      } finally {
        await probe.dispose();
      }
    });

    it("uses newest distinct, case-sensitive prefix matches", async () => {
      const probe = await createZshQualification({
        startup: {
          ".zshrc":
            "print -s -- 'probe older'; print -s -- 'probe newest'; print -s -- 'probe newest'; print -s -- 'Probe ignored'",
        },
      });
      try {
        await probe.grant();
        probe.write("probe ");
        await expect.poll(async () => (await probe.snapshot()).display).toBe("newest  →");
        probe.write("\t");
        await expect.poll(async () => (await probe.snapshot()).accepts).toBe(1);
        expect((await probe.snapshot()).buffer).toBe("probe newest");
      } finally {
        await probe.dispose();
      }
    });

    it("rejects oversized history and multiline/oversized editing buffers", async () => {
      const probe = await createZshQualification({
        startup: { ".zshrc": `print -s -- 'probe ${"x".repeat(4097)}'` },
      });
      try {
        await probe.grant();
        probe.write("probe ");
        await expect.poll(async () => (await probe.snapshot()).buffer).toBe("probe ");
        expect((await probe.snapshot()).display).toBe("");
        probe.write("\u0015\u001b[200~print 'a\nb'\u001b[201~");
        await expect.poll(async () => (await probe.snapshot()).buffer).toBe("print 'a\nb'");
        expect((await probe.snapshot()).display).toBe("");
        probe.write("\u0003");
        await expect.poll(async () => (await probe.snapshot()).buffer).toBe("");
        probe.write(`\u001b[200~${"x".repeat(4097)}\u001b[201~`);
        await expect.poll(async () => (await probe.snapshot()).buffer.length).toBe(4097);
        expect((await probe.snapshot()).display).toBe("");
        expect((await probe.snapshot()).accepts).toBe(0);
      } finally {
        await probe.dispose();
      }
    });
  },
);
