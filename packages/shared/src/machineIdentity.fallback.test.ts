import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installationIdentityFrom,
  machineIdentityFromPlatformId,
  resolveLocalHostIdentity,
} from "./machineIdentity";
import { installationIdPath } from "./machineIdentity.installation";

let base: string;
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-host-")));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const noMachine = () => null;
const host = (name: string) => () => name;

describe.skipIf(process.platform === "win32")("resolveLocalHostIdentity", () => {
  it("keeps the platform identity unchanged and creates no installation file", () => {
    const machine = machineIdentityFromPlatformId("0123456789abcdef0123456789abcdef");
    expect(resolveLocalHostIdentity({ machine: () => machine, baseDir: base })).toEqual({
      source: "machine",
      identity: machine,
    });
    expect(fs.existsSync(path.dirname(installationIdPath(base)))).toBe(false);
  });

  it("falls back to a stable installation identity only without a machine id", () => {
    const first = resolveLocalHostIdentity({
      machine: noMachine,
      baseDir: base,
      hostname: host("c1"),
    });
    expect(first.source).toBe("installation");
    expect(first.identity).toMatch(/^install-v1:[0-9a-f]{64}$/);
    // A restart re-reads the persisted id instead of minting another.
    expect(
      resolveLocalHostIdentity({ machine: noMachine, baseDir: base, hostname: host("c1") }),
    ).toEqual(first);
    const raw = fs.readFileSync(installationIdPath(base), "utf8").trim();
    expect(first.identity).toBe(installationIdentityFrom(raw, "c1"));
    expect(first.identity).not.toContain(raw);
  });

  it("keeps two hosts that share one home distinct by hostname", () => {
    const a = resolveLocalHostIdentity({ machine: noMachine, baseDir: base, hostname: host("a") });
    const b = resolveLocalHostIdentity({ machine: noMachine, baseDir: base, hostname: host("b") });
    expect(a.identity).not.toBe(b.identity);
  });

  it("never collides with a machine identity, even for the same raw value", () => {
    const raw = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const install = installationIdentityFrom(raw, "h");
    const machine = machineIdentityFromPlatformId(raw);
    expect(install.startsWith("install-v1:")).toBe(true);
    expect(machine.startsWith("machine-v1:")).toBe(true);
    expect(install.slice("install-v1:".length)).not.toBe(machine.slice("machine-v1:".length));
  });

  it("fails closed with a clear reason when the installation file is corrupt", () => {
    const file = installationIdPath(base);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "garbage\n", { mode: 0o600 });
    const result = resolveLocalHostIdentity({ machine: noMachine, baseDir: base });
    expect(result).toMatchObject({ source: "none", identity: null });
    expect(result.source === "none" && result.reason).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe("garbage\n");
  });
});
