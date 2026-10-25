import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  runNotarization,
  sanitize,
  isTransient,
} = require("../../../apps/desktop/scripts/notarize.pipeline.cjs");
const directories: string[] = [];
const accepted = JSON.stringify({
  id: "12345678-1234-1234-1234-123456789abc",
  status: "Accepted",
});

function fixture(failures: Record<string, string[]> = {}, submission = accepted) {
  const recoveryDir = mkdtempSync(join(tmpdir(), "bigbud-notarize-test-"));
  directories.push(recoveryDir);
  const run = vi.fn((command: string, args: string[]) => {
    if (command === "ditto") writeFileSync(args.at(-1)!, "signed archive");
    const operation = args[0] === "stapler" ? args[1]! : command;
    const failure = failures[operation]?.shift();
    return {
      ok: !failure,
      output: failure ?? "ok",
      stdout: command === "xcrun" && args[0] === "notarytool" ? submission : "ok",
    };
  });
  const sleep = vi.fn(async () => {});
  const log = vi.fn();
  const options = {
    appPath: "/signed/bigbud.app",
    appleId: "private@example.com",
    password: "secret-password",
    teamId: "TEAM123456",
    recoveryDir,
  };
  const start = () => runNotarization(options, { run, sleep, log });
  const operations = () =>
    run.mock.calls.map(([cmd, args]) => `${cmd} ${args.slice(0, 2).join(" ")}`);
  return { start, run, sleep, log, recoveryDir, operations };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("custom notarization owner", () => {
  it("submits once without library implicit stapling, then staples, validates and assesses", async () => {
    const test = fixture();
    await test.start();
    expect(test.operations()).toEqual([
      "ditto -c -k",
      "xcrun notarytool submit",
      "xcrun stapler staple",
      "xcrun stapler validate",
      "spctl --assess --type",
    ]);
    expect(test.sleep).not.toHaveBeenCalled();
    expect(readdirSync(test.recoveryDir)).toEqual([]);
    const hook = readFileSync(
      new URL("../../../apps/desktop/scripts/notarize.cjs", import.meta.url),
      "utf8",
    );
    expect(hook).not.toContain('require("@electron/notarize")');
  });

  it("retries ticket transport and propagation failures on the same app without resubmitting", async () => {
    const test = fixture({
      staple: ["CloudKit record not found"],
      validate: ["NSURLErrorDomain Code=-1005 network connection was lost"],
    });
    await test.start();
    expect(test.operations().filter((op) => op === "xcrun notarytool submit")).toHaveLength(1);
    expect(test.operations().filter((op) => op === "xcrun stapler staple")).toHaveLength(2);
    expect(test.operations().filter((op) => op === "xcrun stapler validate")).toHaveLength(2);
    expect(test.sleep.mock.calls).toEqual([[5000], [5000]]);
  });

  it("bounds retries and retains accepted submission diagnostics without credentials", async () => {
    const test = fixture({
      validate: Array(4).fill(
        "network connection was lost secret-password private@example.com TEAM123456",
      ),
    });
    await expect(test.start()).rejects.toThrow("failed closed; no resubmission");
    expect(test.sleep.mock.calls).toEqual([[5000], [15000], [30000]]);
    expect(test.operations().filter((op) => op === "xcrun notarytool submit")).toHaveLength(1);
    expect(test.operations()).not.toContain("spctl --assess --type");
    const dir = readdirSync(test.recoveryDir)[0]!;
    expect(readFileSync(join(test.recoveryDir, dir, "signed-app.zip"), "utf8")).toBe(
      "signed archive",
    );
    const metadata = readFileSync(join(test.recoveryDir, dir, "diagnostics.json"), "utf8");
    expect(JSON.parse(metadata)).toMatchObject({
      accepted: true,
      submissionId: JSON.parse(accepted).id,
    });
    expect(metadata).not.toMatch(/secret-password|private@example.com|TEAM123456/);
    expect(JSON.stringify(test.log.mock.calls)).not.toMatch(
      /secret-password|private@example.com|TEAM123456/,
    );
  });

  it.each(["staple", "validate", "spctl"])(
    "fails closed immediately on permanent %s failure",
    async (operation) => {
      const test = fixture({ [operation]: ["invalid signature or ticket"] });
      await expect(test.start()).rejects.toThrow("failed closed");
      expect(test.sleep).not.toHaveBeenCalled();
      expect(test.operations().filter((op) => op === "xcrun notarytool submit")).toHaveLength(1);
    },
  );

  it.each(["Invalid", "In Progress"])(
    "does not resubmit or staple %s submissions",
    async (status) => {
      const test = fixture({}, JSON.stringify({ id: JSON.parse(accepted).id, status }));
      await expect(test.start()).rejects.toThrow("Notarization not accepted");
      expect(test.operations()).not.toContain("xcrun stapler staple");
      expect(test.sleep).not.toHaveBeenCalled();
    },
  );

  it("fails closed on malformed submission JSON", async () => {
    const test = fixture({}, "not json secret-password");
    await expect(test.start()).rejects.toThrow("no valid submission result");
    expect(test.operations()).not.toContain("xcrun stapler staple");
  });

  it("does not retry an ambiguous submit transport failure or proceed to stapling", async () => {
    const test = fixture(
      { xcrun: ["network connection was lost"] },
      JSON.stringify({
        id: JSON.parse(accepted).id,
        status: "In Progress",
      }),
    );
    await expect(test.start()).rejects.toThrow("Notarization not accepted");
    expect(test.operations().filter((op) => op === "xcrun notarytool submit")).toHaveLength(1);
    expect(test.operations()).not.toContain("xcrun stapler staple");
    expect(test.sleep).not.toHaveBeenCalled();
    const dir = readdirSync(test.recoveryDir)[0]!;
    expect(
      JSON.parse(readFileSync(join(test.recoveryDir, dir, "diagnostics.json"), "utf8")),
    ).toMatchObject({ accepted: false, submissionId: JSON.parse(accepted).id });
  });

  it("never submits when signed archive creation fails", async () => {
    const test = fixture({ ditto: ["archive creation failed"] });
    await expect(test.start()).rejects.toThrow("ditto failed");
    expect(test.operations()).not.toContain("xcrun notarytool submit");
    expect(test.sleep).not.toHaveBeenCalled();
  });

  it("redacts environment credentials from retained diagnostics and logs", async () => {
    const secret = "fixture-private-key-material";
    vi.stubEnv("BIGBUD_FIXTURE_PRIVATE_KEY", secret);
    try {
      const test = fixture({ staple: [`invalid ticket ${secret}`] });
      await expect(test.start()).rejects.not.toThrow(secret);
      const dir = readdirSync(test.recoveryDir)[0]!;
      expect(readFileSync(join(test.recoveryDir, dir, "diagnostics.json"), "utf8")).not.toContain(
        secret,
      );
      expect(JSON.stringify(test.log.mock.calls)).not.toContain(secret);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("redacts secrets and recognizes only transient ticket errors", () => {
    expect(
      sanitize("password=hidden token:other private@example.com", ["private@example.com"]),
    ).toBe("password=[REDACTED] token=[REDACTED] [REDACTED]");
    expect(isTransient({ output: "Error 68 invalid ticket" })).toBe(false);
    expect(isTransient({ output: "", timedOut: true })).toBe(true);
  });

  it("disables whole-build retries for signed macOS builds", () => {
    const build = readFileSync(new URL("./build.ts", import.meta.url), "utf8");
    expect(build).toContain('options.target === "dmg" && !options.signed ? 3 : 1');
  });

  it("keeps sidecar/app signature and team verification ahead of submission", async () => {
    const pipeline = vi.fn(async () => {});
    const verify = vi.fn();
    const inspect = vi.fn(() => ({ status: 0, stderr: "TeamIdentifier=TEAM123456" }));
    const hookModule = { exports: async (_context: unknown) => {} };
    runInNewContext(
      readFileSync(new URL("../../../apps/desktop/scripts/notarize.cjs", import.meta.url), "utf8"),
      {
        module: hookModule,
        require: (name: string) => {
          if (name === "./notarize.pipeline.cjs") return { runNotarization: pipeline };
          if (name === "node:child_process") return { execFileSync: verify, spawnSync: inspect };
          return require(name);
        },
        process: {
          env: {
            APPLE_ID: "apple",
            APPLE_APP_SPECIFIC_PASSWORD: "password",
            APPLE_TEAM_ID: "TEAM123456",
            BIGBUD_NOTARIZATION_RECOVERY_DIR: "/recovery",
          },
        },
        console: { log: vi.fn() },
      },
    );
    const context = {
      electronPlatformName: "darwin",
      appOutDir: "/signed",
      packager: { appInfo: { productFilename: "bigbud" } },
    };
    await hookModule.exports({ ...context, electronPlatformName: "linux" });
    expect(pipeline).not.toHaveBeenCalled();
    await hookModule.exports(context);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(verify.mock.calls.at(-1)?.[1]).toContain("--deep");
    expect(pipeline).toHaveBeenCalledOnce();
    inspect.mockReturnValue({ status: 0, stderr: "TeamIdentifier=WRONG" });
    await expect(hookModule.exports(context)).rejects.toThrow("TeamIdentifier mismatch");
    expect(pipeline).toHaveBeenCalledOnce();
  });
});
