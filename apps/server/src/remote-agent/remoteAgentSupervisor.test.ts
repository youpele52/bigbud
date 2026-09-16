import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildOptionalRemoteAgentSupervisorPreparationCommand,
  buildRemoteAgentProxyCommand,
} from "./remoteAgentSupervisor.ts";

describe("remote agent rollback preparation", () => {
  it("reconnects legacy using supported raw proxy without entering stateful stdio", () => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-legacy-proxy-"));
    try {
      const binary = join(root, "agent");
      writeFileSync(
        binary,
        `#!/bin/sh
if [ "$1" = --check ]; then
  printf 'bigbud-remote-agent\\t0.2.205\\t1\\t2\\tlegacy\\tlinux\\taarch64\\n'
elif [ "$1" = --proxy ]; then
  printf proxy
else
  printf rotated > "$HOME/epoch"
  exit 99
fi
`,
      );
      chmodSync(binary, 0o700);
      writeFileSync(join(root, "epoch"), "original");
      const result = spawnSync("sh", ["-c", buildRemoteAgentProxyCommand(binary)], {
        env: { ...process.env, HOME: root },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("proxy");
      expect(readFileSync(join(root, "epoch"), "utf8")).toBe("original");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { version: "0.2.206", checkStatus: 0, prepareStatus: 0 },
    { version: "0.2.207", checkStatus: 0, prepareStatus: 11 },
    { version: "0.2.207", checkStatus: 7, prepareStatus: 0 },
  ])("preserves supported preparation and check errors: %o", (fixture) => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-rollback-check-"));
    try {
      const binary = join(root, "agent");
      writeFileSync(
        binary,
        `#!/bin/sh
if [ "$1" = --check ]; then
  printf 'bigbud-remote-agent\\t${fixture.version}\\t1\\t2\\tdigest\\tlinux\\taarch64\\n'
  exit ${fixture.checkStatus}
fi
if [ "$1" = --prepare-supervisor ]; then
  printf 'prepared'
  exit ${fixture.prepareStatus}
fi
exit 99
`,
      );
      chmodSync(binary, 0o700);
      const result = spawnSync(
        "sh",
        ["-c", buildOptionalRemoteAgentSupervisorPreparationCommand(binary)],
        { env: { ...process.env, HOME: root }, encoding: "utf8", timeout: 5_000 },
      );
      expect(result.status).toBe(fixture.checkStatus || fixture.prepareStatus);
      expect(result.stdout).toBe(fixture.checkStatus ? "" : "prepared");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not enter legacy 0.2.205 stateful stdio on repeated rollback", () => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-legacy-rollback-"));
    try {
      const binary = join(root, "agent");
      const epoch = join(root, "epoch");
      writeFileSync(epoch, "live-supervisor-epoch");
      // v0.2.205 main.rs recognizes --check, but unknown flags create a stateful session.
      writeFileSync(
        binary,
        `#!/bin/sh
if [ "$1" = --check ]; then
  printf 'bigbud-remote-agent\\t0.2.205\\t1\\t2\\tlegacy-digest\\tlinux\\taarch64\\n'
  exit 0
fi
printf 'rotated' > "$HOME/epoch"
exit 0
`,
      );
      chmodSync(binary, 0o700);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync(
          "sh",
          ["-c", buildOptionalRemoteAgentSupervisorPreparationCommand(binary)],
          { env: { ...process.env, HOME: root }, encoding: "utf8", timeout: 5_000 },
        );
        expect(readFileSync(epoch, "utf8")).toBe("live-supervisor-epoch");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("0.2.205 does not support safe supervisor preparation");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
