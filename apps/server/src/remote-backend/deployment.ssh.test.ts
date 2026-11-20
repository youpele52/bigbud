import { afterEach, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ remoteEnv: undefined as unknown }));
vi.mock("../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReadyAsync: async () => {},
}));
vi.mock("../ssh/sshCommand.ts", async (original) => {
  const actual = await original<typeof import("../ssh/sshCommand.ts")>();
  return {
    ...actual,
    // Stands in for the local `ssh` client: prints the environment it was spawned with.
    buildSshCommandInvocation: (input: { readonly env?: unknown }) => {
      seen.remoteEnv = input.env;
      return {
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      };
    },
  };
});

import { runDeploymentSsh } from "./deployment.ssh.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("keeps the local ssh client environment and sends the remote env only in the command", async () => {
  vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
  vi.stubEnv("PATH", `/opt/proxy-tools:${process.env.PATH ?? ""}`);
  const remoteEnv = { HOME: "/home/remote", LANG: "C.UTF-8" };
  const result = await runDeploymentSsh(
    "ssh:host=vps&user=dev&port=22&auth=ssh-key",
    { command: "/remote/node", args: ["bin.mjs"], env: remoteEnv, timeoutMs: 30_000 },
    new AbortController().signal,
  );
  expect(result.code).toBe(0);
  expect(seen.remoteEnv).toEqual(remoteEnv);
  const local = JSON.parse(result.stdout) as Record<string, string>;
  expect(local.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
  expect(local.PATH?.startsWith("/opt/proxy-tools:")).toBe(true);
  expect(local.HOME).toBe(process.env.HOME);
  expect(local.HOME).not.toBe("/home/remote");
});
