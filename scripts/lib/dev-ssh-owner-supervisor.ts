import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const startupMs = 30_000;
const retirementMs = 40_000;
const entry = fileURLToPath(
  new URL("../../apps/server/src/ssh/sshOwnerDevRuntime.supervisor.ts", import.meta.url),
);

/** The only lifetime edge is our owned child handle and its stdin. No PID adoption. */
export function launchRetainedDevSshOwner(input: {
  bun: string;
  profile: string;
  binary: string;
  home?: string | undefined;
  preload?: { path: string; trace: string };
}) {
  const child = spawn(
    input.bun,
    ["run", "--no-env-file", ...(input.preload ? ["--preload", input.preload.path] : []), entry],
    {
      detached: true, // Only our lifetime edge stops the fixture, not backend or process-group signals.
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE: input.profile,
        BIGBUD_SSH_OWNER_BIN: input.binary,
        HOME: input.home,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/sh",
        ...(input.preload ? { BIGBUD_TEST_SSH_OWNER_BACKEND_TRACE: input.preload.trace } : {}),
      },
    },
  );
  child.stdin.on("error", () => child.stdin.destroy());
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      const deadline = setTimeout(() => child.kill("SIGKILL"), retirementMs);
      child.stdin.end();
      try {
        if ((await exited) !== 0)
          throw new Error("The disposable SSH fixture did not retire cleanly.");
      } finally {
        clearTimeout(deadline);
      }
    })());
  const ready = new Promise<void>((resolve, reject) => {
    const unavailable = () => {
      clearTimeout(timer);
      reject(new Error("The disposable SSH fixture did not become ready."));
    };
    const timer = setTimeout(unavailable, startupMs);
    let pending = "";
    child.once("error", unavailable);
    const read = (data: string) => {
      pending += data;
      if (!"ready\n".startsWith(pending)) unavailable();
      else if (pending === "ready\n") {
        clearTimeout(timer);
        child.stdout.off("data", read);
        child.stdout.resume();
        resolve();
      }
    };
    child.stdout.setEncoding("utf8").on("data", read);
    void exited.then(unavailable);
  });
  return { ready, exited, stop };
}
