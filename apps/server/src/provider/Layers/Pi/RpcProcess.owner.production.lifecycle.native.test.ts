import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import {
  localProcesses,
  remoteShell,
  waitUntil,
} from "../../../ssh/sshOwnerProductionProviderLease.native.fixture.ts";
import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { startPi, trusted } from "./RpcProcess.owner.production.native.fixture.ts";
import { PiProductionResumeRefusedError } from "./RpcProcess.owner.production.ts";

// W2 T-prov live proof (U20 resume and owner crash) against a disposable Linux sshd with the real
// Pi CLI on the login PATH (see RpcProcess.owner.production.native.test.ts for the target JSON):
// BIGBUD_TEST_PROVIDER_LEASE_EXTERNAL_TARGET='{…}' BIGBUD_TEST_PROVIDER_LEASE_EXPECT=ready
const external = readExternalV2Target(process.env.BIGBUD_TEST_PROVIDER_LEASE_EXTERNAL_TARGET);
const enabled =
  external !== undefined &&
  process.env.BIGBUD_TEST_PROVIDER_LEASE_EXPECT === "ready" &&
  (process.platform === "darwin" || process.platform === "linux");

interface PiState {
  readonly sessionFile?: string;
  readonly sessionId?: string;
}

it.skipIf(!enabled)(
  "resumes a Pi session file only from the account's own sessions directory",
  async () => {
    const id = randomUUID();
    const dir = "$HOME/.pi/agent/sessions/bigbud-tprov";
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: new Date().toISOString(),
      cwd: external!.cwd,
    });
    const home = remoteShell(
      external!,
      `set -e; mkdir -p ${dir}; printf '%s\\n' '${header}' > ${dir}/s.jsonl; ` +
        `cp ${dir}/s.jsonl /tmp/tprov/outside.jsonl; ln -sf /tmp/tprov/outside.jsonl ${dir}/escape.jsonl; ` +
        `printf '%s' "$HOME"`,
    ).trim();
    const sessions = `${home}/.pi/agent/sessions/bigbud-tprov`;
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const [target] = targets;
        await trusted(handle, target!);
        const resumed = await startPi(handle, target!, "thread-resume", `${sessions}/s.jsonl`);
        const state = await resumed.request<PiState>({ type: "get_state" }, 20_000);
        expect(state.success).toBe(true);
        expect(state.data?.sessionFile).toBe(`${sessions}/s.jsonl`);
        expect(state.data?.sessionId).toBe(id);
        await resumed.stop();
        for (const refused of [`${sessions}/escape.jsonl`, "/tmp/tprov/outside.jsonl"]) {
          await expect(startPi(handle, target!, "thread-refused", refused)).rejects.toBeInstanceOf(
            PiProductionResumeRefusedError,
          );
        }
      },
      { binding: {} },
    );
    remoteShell(external!, `rm -rf ${dir} /tmp/tprov/outside.jsonl`);
  },
  180_000,
);

it.skipIf(!enabled)(
  "a provider lease does not outlive a killed owner on either host",
  async () => {
    const remoteProviders = () =>
      remoteShell(
        external!,
        "pgrep -u \"$USER\" -fa '[t]prov/pi|[f]d/9|[b]igbud-provider' || true",
      ).trim();
    expect(remoteProviders()).toBe("");
    let proved = false;
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const [target] = targets;
        await trusted(handle, target!);
        const pi = await startPi(handle, target!, "thread-crash");
        expect((await pi.request({ type: "get_state" }, 20_000)).success).toBe(true);
        expect(localProcesses("bigbud-provider-lease").length).toBeGreaterThan(0);
        expect(remoteProviders()).not.toBe("");
        const owners = localProcesses("bigbud-ssh-owner --production").filter(
          ({ ppid }) => ppid === process.pid,
        );
        expect(owners).toHaveLength(1);
        process.kill(owners[0]!.pid, "SIGKILL");
        // Locally the guard kills the SSH client's group; remotely the session guard reaps Pi.
        expect(
          await waitUntil(() => localProcesses("bigbud-provider-lease").length === 0, 5_000),
        ).toBe(true);
        expect(await waitUntil(() => remoteProviders() === "", 10_000)).toBe(true);
        proved = true;
      },
      { binding: {} },
    ).catch((error: unknown) => {
      // The owner was killed on purpose; only its own teardown may fail after the proof.
      if (!proved) throw error;
    });
    expect(proved).toBe(true);
  },
  180_000,
);
