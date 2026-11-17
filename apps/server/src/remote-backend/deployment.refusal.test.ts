import { expect, it } from "vitest";
import { runRemoteBackendSetup } from "./deployment.remoteSetup.ts";
import { SETUP_ADOPTION_REFUSAL_CODES } from "./localSupervisorService.setup.adoption.rules.ts";

const runner =
  (code: number, stderr: string, stdout = "") =>
  async () => ({ code, stdout, stderr });
const setup = (run: ReturnType<typeof runner>) =>
  runRemoteBackendSetup({
    run,
    executionTargetId: "ssh:host",
    requestId: "11111111-1111-4111-8111-111111111111",
    paths: {
      home: "/home/u",
      installDir: "/i",
      graphRoot: "/g",
      nodeBinary: "/g/node",
      entry: "/g/bin.mjs",
      rustManifest: "/r",
      trustedKeys: "/k",
    },
    signal: new AbortController().signal,
  });

it.each(SETUP_ADOPTION_REFUSAL_CODES)(
  "deployment maps the %s refusal without echoing remote text",
  async (reason) => {
    const error = await setup(
      runner(1, `bigbud backend: Setup refused (${reason}): REMOTE-SECRET\nbigbud backend: x\n`),
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "setup-failed", reason });
    expect(JSON.stringify(error)).not.toContain("REMOTE-SECRET");
  },
);

it("keeps the generic setup failure for unknown or successful-looking output", async () => {
  for (const run of [
    runner(1, "bigbud backend: Operation unavailable or incomplete.\n"),
    runner(1, "bigbud backend: Setup refused (made-up): x\n"),
    runner(0, "bigbud backend: Setup refused (foreign-owner): x\n"),
  ]) {
    const error = (await setup(run).catch((cause: unknown) => cause)) as { reason?: string };
    expect(error).toMatchObject({ code: "setup-failed" });
    expect(error.reason).toBeUndefined();
  }
  await expect(setup(runner(0, "", `Configured authority: ${"c".repeat(32)}\n`))).resolves.toBe(
    "c".repeat(32),
  );
});
