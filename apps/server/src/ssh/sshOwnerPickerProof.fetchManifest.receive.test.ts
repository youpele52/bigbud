import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  branch,
  configureReceiver,
  git,
  init,
  seed,
} from "./sshOwnerPickerProof.gitReceive.fixture.ts";
import { live, withFixture } from "./sshOwnerPickerProof.scopedNative.fixture.ts";

const exec = promisify(execFile);
it.skipIf(!live).each(["approved", "wrong-source", "wrong-host-key"] as const)(
  "limits native SSH receive-pack to the approved synthetic update (%s)",
  (mode) =>
    withFixture(async (fixture) => {
      const client = init(fixture.root, "client.git");
      const repository = init(fixture.root, "receive.git");
      const old = seed(repository, "old fixture");
      expect(seed(client, "old fixture")).toBe(old);
      git(repository, ["update-ref", branch, old]);
      const approved = seed(client, "approved fixture", old);
      const wrong = seed(client, "unapproved fixture", old);
      const before = (await readdir(repository, { recursive: true })).toSorted();
      await configureReceiver(
        fixture.root,
        fixture.identity,
        fixture.knownHosts,
        fixture.port,
        old,
        approved,
        mode === "wrong-host-key",
      );
      // Explicit Cargo prerequisite: cargo build --locked -p bigbud-ssh-owner --example git_receive_fixture
      const launcher = await fixture.installOwner(
        fileURLToPath(
          new URL("../../../../target/debug/examples/git_receive_fixture", import.meta.url),
        ),
      );
      const run = exec(
        launcher,
        ["push", old, approved, mode === "wrong-source" ? wrong : approved],
        {
          cwd: fixture.root,
          env: {},
          timeout: 23_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        },
      );
      const marker = path.join(fixture.root, "receiver-entered");
      const hook = path.join(fixture.root, "hook-entered");
      const trace = path.join(fixture.root, "receive.trace");
      if (mode === "approved") {
        await expect(run).resolves.toMatchObject({
          stderr: expect.stringContaining("fixture receipt: Accepted"),
        });
        expect(git(repository, ["for-each-ref", "--format=%(objectname) %(refname)"])).toBe(
          `${approved} ${branch}`,
        );
        expect(git(repository, ["cat-file", "blob", `${branch}:proof.txt`])).toBe(
          "approved fixture",
        );
        expect(git(repository, ["fsck", "--strict", "--no-reflogs"])).toBe("");
        await expect(readFile(marker, "utf8")).resolves.toBe("entered\n");
        await expect(readFile(hook, "utf8")).resolves.toBe("entered\n");
        await expect(readFile(trace, "utf8")).resolves.toContain(
          `receive-pack< ${old} ${approved} ${branch}`,
        );
      } else {
        await expect(run).rejects.toMatchObject({
          stderr: expect.stringContaining(
            mode === "wrong-source"
              ? "no update admitted (Gate(RefusedUpdate))"
              : "Host key verification failed",
          ),
        });
        expect(git(repository, ["for-each-ref", "--format=%(objectname) %(refname)"])).toBe(
          `${old} ${branch}`,
        );
        expect((await readdir(repository, { recursive: true })).toSorted()).toEqual(before);
        await expect(readFile(hook, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        if (mode === "wrong-source") {
          await expect(readFile(marker, "utf8")).resolves.toBe("entered\n");
          const packets = await readFile(trace, "utf8");
          expect(packets).toContain(`receive-pack> ${old} ${branch}`);
          expect(packets).not.toMatch(/receive-pack< [0-9a-f]{40} /);
        } else {
          await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          await expect(readFile(trace, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(() => git(repository, ["cat-file", "-e", wrong])).toThrow();
    }),
  45_000,
);
