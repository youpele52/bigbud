import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const linuxControlAvailable =
  process.platform === "linux" ||
  (process.env.BIGBUD_TEST_LINUX_DOCKER === "1" && dockerIsAvailable());

export type LinuxFixtureArchitecture = "aarch64" | "x86_64";
export type LinuxFixtureRole = "legacy" | "candidate" | "journal-seed";

export interface LinuxFixtureAvailability {
  readonly available: boolean;
  readonly reason: string;
  readonly provenance: "source-built";
  readonly artifactTrust: "not-published";
}

function dockerIsAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fixtureCandidates(
  role: LinuxFixtureRole,
  architecture: LinuxFixtureArchitecture,
): ReadonlyArray<string> {
  if (role === "journal-seed") return ["legacy-journal-seed"];
  const base = role === "legacy" ? "legacy-reviewed-0.2.205" : "candidate-reviewed-0.2.207";
  return architecture === "aarch64"
    ? [base, `${base}-aarch64`, `${base}-aarch64-unknown-linux-gnu`]
    : [`${base}-x86_64`, `${base}-x86_64-unknown-linux-gnu`, `${base}-amd64`];
}

function unavailableLinuxFixture(reason: string): LinuxFixtureAvailability {
  return {
    available: false,
    reason,
    provenance: "source-built",
    artifactTrust: "not-published",
  };
}

export function linuxFixtureName(
  role: LinuxFixtureRole,
  architecture: LinuxFixtureArchitecture,
): string {
  const directory = process.env.BIGBUD_TEST_AGENT_FIXTURES?.trim();
  const name = fixtureCandidates(role, architecture).find((candidate) =>
    directory ? existsSync(join(directory, candidate)) : false,
  );
  if (!name) throw new Error(`Missing ${role} ${architecture} Linux fixture.`);
  return name;
}

export function linuxFixtureAvailability(
  architecture: LinuxFixtureArchitecture,
  roles: ReadonlyArray<LinuxFixtureRole> = ["legacy", "candidate"],
): LinuxFixtureAvailability {
  const directory = process.env.BIGBUD_TEST_AGENT_FIXTURES?.trim();
  if (process.env.BIGBUD_TEST_LINUX_DOCKER !== "1")
    return unavailableLinuxFixture("BIGBUD_TEST_LINUX_DOCKER=1 is not enabled");
  if (!directory) return unavailableLinuxFixture("BIGBUD_TEST_AGENT_FIXTURES is not set");
  if (!dockerIsAvailable()) return unavailableLinuxFixture("Docker is unavailable");
  const missing = roles.filter(
    (role) =>
      !fixtureCandidates(role, architecture).some((candidate) =>
        existsSync(join(directory, candidate)),
      ),
  );
  return missing.length
    ? unavailableLinuxFixture(`missing ${architecture} fixture(s): ${missing.join(", ")}`)
    : {
        available: true,
        reason: "matching Docker fixtures are available",
        provenance: "source-built",
        artifactTrust: "not-published",
      };
}

export async function countPhysicalRemoteAgentExecutables(
  fixture: ReturnType<typeof createLinuxControlFixture>,
  root: string,
): Promise<number> {
  const output = await fixture.run(
    `find -P '${root}/bin' -type f -name bigbud-remote-agent -perm -100 -print | wc -l`,
  );
  const count = Number(output.trim());
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error("Invalid physical executable count.");
  return count;
}

/** Owned, network-disabled Linux fixture; Docker skips are never counted as Linux passes. */
export function createLinuxControlFixture() {
  const docker = process.env.BIGBUD_TEST_LINUX_DOCKER === "1";
  const container = docker
    ? execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-d",
          "--network=none",
          "--pull=never",
          ...(process.env.BIGBUD_TEST_AGENT_FIXTURES
            ? [
                "--mount",
                `type=bind,src=${process.env.BIGBUD_TEST_AGENT_FIXTURES},dst=/fixtures,readonly`,
              ]
            : []),
          "rust:1.95-bookworm",
          "sleep",
          "300",
        ],
        { encoding: "utf8" },
      ).trim()
    : undefined;
  const root = docker ? "/tmp/agent" : mkdtempSync(join(tmpdir(), "bigbud-control-"));
  const run = async (command: string): Promise<string> => {
    const result = await execute(
      container ? "docker" : "sh",
      container ? ["exec", container, "sh", "-c", command] : ["-c", command],
      {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return result.stdout;
  };
  return {
    root,
    run,
    container,
    runInput: (command: string, input: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          container ? "docker" : "sh",
          container ? ["exec", "-i", container, "sh", "-c", command] : ["-c", command],
        );
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Fixture command deadline exceeded."));
        }, 30_000);
        child.stdout.on("data", (data) => {
          stdout = `${stdout}${String(data)}`.slice(-2 * 1024 * 1024);
        });
        child.stderr.on("data", (data) => {
          stderr = `${stderr}${String(data)}`.slice(-4096);
        });
        child.on("error", (cause) => {
          clearTimeout(timeout);
          reject(cause);
        });
        child.stdin.on("error", (cause) => {
          clearTimeout(timeout);
          reject(cause);
        });
        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve(stdout);
          else reject(new Error(`Fixture command exited ${code}: ${stderr}`));
        });
        child.stdin.end(input);
      }),
    close: () => {
      if (container) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      else rmSync(root, { recursive: true, force: true });
    },
  };
}
