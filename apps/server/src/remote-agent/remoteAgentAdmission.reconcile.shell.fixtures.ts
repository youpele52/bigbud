import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { failedInstallFixture } from "./remoteAgentAdmission.restart.fixtures.ts";

const execute = promisify(execFile);

// Execute the production Linux shell on Darwin with real filesystem metadata and flock(2).
// These adapters translate utilities only; no admission/epoch/death result is fabricated.
const darwinUtilities = `
stat() {
  case "$2" in
    %a) mode=$(command stat -f '%p' "$4"); printf '%o\\n' "$((0$mode & 07777))"; return ;;
    %u) format=%u ;; %h) format=%l ;; *) return 1 ;;
  esac
  command stat -f "$format" "$4"
}
readlink() { command python3 -c 'import os,sys; print(os.path.realpath(sys.argv[-1]))' "$@"; }
flock() {
  command python3 -c 'import fcntl,sys
try:
 fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
 sys.exit(75)' "$@"
}
`;

export async function admissionShellFixture(epochMode = 0o700) {
  const f = await failedInstallFixture();
  const root = realpathSync(mkdtempSync("/tmp/bigbud-mr-"));
  const statePath = join(root, "runtimes", "g2");
  mkdirSync(statePath, { recursive: true, mode: 0o700 });
  const epoch = "1794744077265471573";
  for (const [name, value] of [
    ["epoch", epoch],
    ["launch.intent", "launch-g2"],
    ["launch.lock", ""],
    ["launch.exit", "137"],
  ]) {
    writeFileSync(join(statePath, name!), value!, { mode: 0o600 });
  }
  // AgentState::open applies its private-permissions helper (0700) to the epoch file.
  chmodSync(join(statePath, "epoch"), epochMode);
  const before = await f.control.registry.update((state) => ({
    ...state,
    revision: state.revision + 1,
    builds: state.builds.map((build) => ({
      ...build,
      runtime: {
        ...build.runtime,
        binaryPath: `${root}/bin/${build.runtime.version}/${build.runtime.sha256}/bigbud-remote-agent`,
        statePath: `${root}/runtimes/${build.runtime.generation}`,
        socketPath: `${root}/runtimes/${build.runtime.generation}/supervisor.sock`,
        logPath: `${root}/runtimes/${build.runtime.generation}/supervisor.log`,
      },
    })),
    launches: state.launches.map((launch) => (launch.id === "g2" ? { ...launch, epoch } : launch)),
    admissions: state.admissions.map((admission) => ({ ...admission, epoch })),
  }));
  const otherCommand = f.run.getMockImplementation()!;
  const observations: string[] = [];
  f.run.mockImplementation(async (command) => {
    if (!command.includes("# Failed admission death observation")) return otherCommand(command);
    const result = await execute(
      "sh",
      ["-c", `${process.platform === "darwin" ? darwinUtilities : ""}\n${command}`],
      { timeout: 5_000 },
    );
    observations.push(result.stdout.trim());
    return result.stdout;
  });
  return {
    ...f,
    before,
    epoch,
    statePath,
    observations,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
