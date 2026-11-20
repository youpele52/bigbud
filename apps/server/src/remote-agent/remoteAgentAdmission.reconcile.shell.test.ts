import { chmodSync, linkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admissionShellFixture } from "./remoteAgentAdmission.reconcile.shell.fixtures.ts";

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "failed admission executable shell proof",
  () => {
    let f: Awaited<ReturnType<typeof admissionShellFixture>> | undefined;
    afterEach(() => {
      f?.close();
      f = undefined;
    });

    it.each([0o700, 0o600])(
      "accepts the private epoch mode %s through install failure and managed restart",
      async (mode) => {
        f = await admissionShellFixture(mode);
        expect(await f.install()).toMatchObject({ outcome: "failed" });
        expect(f.observations).toEqual(["exited:137"]);
        const failed = await f.control.registry.read();
        expect(failed.admissions).toEqual(f.before.admissions);
        expect(failed.pins).toEqual(f.before.pins);
        expect(failed.admissionRetirements).toContainEqual(
          expect.objectContaining({ id: "failed", outcome: "rejected" }),
        );
        expect(await f.restart.restart(f.request)).toMatchObject({
          phase: "ready",
          oldEpoch: f.epoch,
        });
      },
    );

    it.each([0o644, 0o755, 0o777, 0o1700])(
      "retains admission and pins for unsafe epoch mode %s",
      async (mode) => {
        f = await admissionShellFixture(mode);
        await f.install();
        expect(f.observations).toEqual(["unknown"]);
        const state = await f.control.registry.read();
        expect(state.admissions).toContainEqual(
          expect.objectContaining({ id: "failed", phase: "prepared" }),
        );
        expect(state.pins).toContainEqual({
          owner: "activation:failed:g2",
          buildId: f.initial.current,
        });
        await expect(f.restart.restart(f.request)).rejects.toThrow("unresolved or mismatched");
      },
    );

    it.each([
      "symlink",
      "hardlink",
      "wrong-epoch",
      "oversize",
      "wrong-attempt",
      "malformed-exit",
      "public-lock",
    ])("preserves identity protection for %s", async (condition) => {
      f = await admissionShellFixture();
      const epoch = join(f.statePath, "epoch");
      if (condition === "symlink") {
        renameSync(epoch, `${epoch}.saved`);
        symlinkSync(`${epoch}.saved`, epoch);
      }
      if (condition === "hardlink") linkSync(epoch, `${epoch}.saved`);
      if (condition === "wrong-epoch") writeFileSync(epoch, "another-epoch");
      if (condition === "oversize") writeFileSync(epoch, "1".repeat(257));
      if (condition === "wrong-attempt")
        writeFileSync(join(f.statePath, "launch.intent"), "another-attempt");
      if (condition === "malformed-exit")
        writeFileSync(join(f.statePath, "launch.exit"), "not-an-exit");
      if (condition === "public-lock") chmodSync(join(f.statePath, "launch.lock"), 0o644);
      await f.install();
      expect(f.observations).toEqual(["unknown"]);
      expect((await f.control.registry.read()).admissionRetirements).toEqual([]);
      expect((await f.control.registry.read()).pins).toContainEqual({
        owner: "activation:failed:g2",
        buildId: f.initial.current,
      });
    });
  },
);
