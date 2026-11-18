import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { buildRemoteAgentRetirementDeletionCommand } from "./remoteAgentInstall.retirement.deletion.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

describe.runIf(linuxControlAvailable)("exact retirement deletion on Linux", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());

  async function setup() {
    fixture = createLinuxControlFixture();
    const sha256 = createHash("sha256").update("fixture-binary").digest("hex");
    const versionPath = `${fixture.root}/bin/0.3.3`;
    const directory = `${versionPath}/${sha256}`;
    const statePath = `${fixture.root}/runtimes/g-delete`;
    const runtime = validateRemoteAgentRuntime({
      generation: "g-delete",
      version: "0.3.3",
      sha256,
      buildDigest: "fixture",
      targetTriple: "x86_64-unknown-linux-musl",
      origin: "managed",
      binaryPath: `${directory}/bigbud-remote-agent`,
      statePath,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    });
    await fixture.run(
      `umask 077; mkdir -p '${directory}' '${statePath}'; printf fixture-binary > '${runtime.binaryPath}'; chmod 700 '${runtime.binaryPath}'`,
    );
    const command = buildRemoteAgentRetirementDeletionCommand(runtime);
    return { runtime, directory, versionPath, statePath, command };
  }

  it("removes only empty owned generation/digest/version directories and is idempotent", async () => {
    const f = await setup();
    expect(await fixture.run(f.command)).toBe("deleted");
    expect(
      await fixture.run(
        `test ! -e '${f.directory}'; test ! -e '${f.versionPath}'; test ! -e '${f.statePath}'; test -d '${fixture.root}/bin'; test -d '${fixture.root}/runtimes'; printf preserved`,
      ),
    ).toBe("preserved");
    expect(await fixture.run(f.command)).toBe("deleted");
  });

  it("preserves logs, sibling builds and other nonempty content", async () => {
    const f = await setup();
    await fixture.run(
      `touch '${f.directory}/restage'; mkdir '${f.versionPath}/other-build'; printf log > '${f.runtime.logPath}'`,
    );
    expect(await fixture.run(f.command)).toBe("deleted");
    expect(
      await fixture.run(
        `test -f '${f.directory}/restage'; test -d '${f.versionPath}/other-build'; cat '${f.runtime.logPath}'`,
      ),
    ).toBe("log");
  });

  it("preserves directories receiving a concurrent stage or launch before rmdir", async () => {
    const f = await setup();
    const inject = `rmdir() {
  case "$2" in '${f.directory}'|'${f.statePath}') touch "$2/concurrent-work" ;; esac
  command rmdir "$@"
}
`;
    expect(await fixture.run(inject + f.command)).toBe("deleted");
    expect(
      await fixture.run(
        `test -f '${f.directory}/concurrent-work'; test -f '${f.statePath}/concurrent-work'; printf preserved`,
      ),
    ).toBe("preserved");
  });

  it("preserves foreign-owned directories", async (context) => {
    const f = await setup();
    if ((await fixture.run("id -u")).trim() !== "0") context.skip();
    await fixture.run(`chown 65534 '${f.directory}' '${f.statePath}'`);
    expect(await fixture.run(f.command)).toBe("deleted");
    expect(
      await fixture.run(`test -d '${f.directory}'; test -d '${f.statePath}'; printf preserved`),
    ).toBe("preserved");
  });

  it("never follows a symlinked runtime directory or binary parent", async () => {
    const f = await setup();
    const outside = `${fixture.root}/outside`;
    await fixture.run(
      `mkdir '${outside}'; rmdir '${f.statePath}'; ln -s '${outside}' '${f.statePath}'`,
    );
    expect(await fixture.run(f.command)).toBe("deleted");
    expect(
      await fixture.run(`test -L '${f.statePath}'; test -d '${outside}'; printf preserved`),
    ).toBe("preserved");
    await fixture.run(
      `mkdir -p '${f.versionPath}'; ln -s '${outside}' '${f.directory}'; printf fixture-binary > '${outside}/bigbud-remote-agent'; chmod 700 '${outside}/bigbud-remote-agent'`,
    );
    await expect(fixture.run(f.command)).rejects.toThrow();
    expect(await fixture.run(`cat '${outside}/bigbud-remote-agent'`)).toBe("fixture-binary");
  });

  it("refuses changed bytes and paths outside the managed identity", async () => {
    const f = await setup();
    await fixture.run(`printf changed > '${f.runtime.binaryPath}'`);
    await expect(fixture.run(f.command)).rejects.toThrow();
    expect(await fixture.run(`cat '${f.runtime.binaryPath}'`)).toBe("changed");
    expect(() =>
      buildRemoteAgentRetirementDeletionCommand({ ...f.runtime, statePath: "/tmp/elsewhere" }),
    ).toThrow();
  });
});
