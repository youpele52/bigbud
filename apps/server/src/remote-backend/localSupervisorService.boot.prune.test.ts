import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import { describe, expect, it, vi } from "vitest";
import { restartRemoteAgentRuntime } from "../remote-agent/remoteAgentRestart.runtime.ts";
import {
  accountBootRequestId,
  makeLocalSupervisorBootProgressStore,
  settledBootReservationsRetained,
} from "./localSupervisorService.boot.store.ts";
import { bootFixture } from "./localSupervisorService.boot.test.helpers.ts";

const row = (id: string, phase: "ready" | "failed" | "starting") => ({
  id,
  buildId: "b",
  generation: "g1",
  expectedEpoch: "1",
  phase,
});

describe("account boot reservations per predecessor epoch", () => {
  it("drops finished history but keeps unfinished rows and this boot's failures", () => {
    const target = `remote-backend:${"a".repeat(32)}`;
    const account = `account-boot:${target}`;
    const kept = [
      row(`${account}:boot-2:g1:41`, "failed"),
      row(`${account}:boot-1:g1:40`, "starting"),
      row(`account-boot:remote-backend:${"b".repeat(32)}:boot-1:g1:9`, "ready"),
      row("restart-request", "ready"),
    ];
    const state = {
      restartReservations: [
        row(`${account}:boot-1:g1:38`, "ready"),
        row(`${account}:boot-1:g1:39`, "failed"),
        row(`${account}:boot-2:g1:42`, "ready"),
        ...kept,
      ],
    } as unknown as Parameters<typeof settledBootReservationsRetained>[0];
    expect(settledBootReservationsRetained(state, target, `${account}:boot-2:g1:43`)).toEqual(kept);
  });

  it("names each replacement by its predecessor epoch and resumes an unfinished one", () => {
    const f = bootFixture();
    const state = f.state();
    const binding = (expectedEpoch: string) => ({ runtime: f.selected, expectedEpoch });
    const prefix = `account-boot:${f.target}:boot-1:${f.selected.generation}:`;
    const ready = { ...state, restartReservations: [row(`${prefix}42`, "ready")] };
    // F1: a per-boot id made the second stop on one boot replay the finished first replacement.
    expect(accountBootRequestId(ready, f.target, "boot-1", binding("43"))).toBe(`${prefix}43`);
    const unfinished = { ...state, restartReservations: [row(`${prefix}43`, "starting")] };
    expect(accountBootRequestId(unfinished, f.target, "boot-1", binding("43"))).toBe(`${prefix}43`);
    expect(accountBootRequestId(unfinished, f.target, "boot-2", binding("43"))).toBe(
      `account-boot:${f.target}:boot-2:${f.selected.generation}:43`,
    );
  });

  it("replaces a second dead epoch on the same boot after the first replacement", async () => {
    const f = bootFixture();
    let binding: RemoteAgentRuntimeBinding = { runtime: f.selected, expectedEpoch: "42" };
    const epochs = ["43", "44"];
    const dependencies = (store: typeof f.store) => ({
      store,
      stopLiveSupervisor: false,
      close: vi.fn(),
      reconnect: vi.fn(async () => undefined),
      resolveBinding: async () => binding,
      verifySsh: async () => undefined,
      control: async () => f.owner,
      verifyReadiness: vi.fn(async () => epochs.shift() ?? "exhausted"),
      launchReplacement: vi.fn(async () => "launch-reserved"),
      bindReplacement: async (_t: string, _c: string, replacement: typeof binding) => {
        binding = replacement;
      },
    });
    const prefix = `account-boot:${f.target}:boot-1:${f.selected.generation}:`;
    const first = `${prefix}42`;
    const firstStore = makeLocalSupervisorBootProgressStore({
      control: f.control,
      runtime: f.selected,
      oldEpoch: "42",
      requestId: first,
    });
    await expect(
      restartRemoteAgentRuntime(dependencies(firstStore), {
        requestId: first,
        expectedWorkspaceExecutionTargetId: f.target,
      }),
    ).resolves.toMatchObject({ phase: "ready", replacementEpoch: "43" });
    // The replacement settled and was then stopped again: its epoch, not the boot, names the next.
    const second = `${prefix}${binding.expectedEpoch}`;
    const secondStore = makeLocalSupervisorBootProgressStore({
      control: f.control,
      runtime: f.selected,
      oldEpoch: "43",
      requestId: second,
    });
    await expect(
      restartRemoteAgentRuntime(dependencies(secondStore), {
        requestId: second,
        expectedWorkspaceExecutionTargetId: f.target,
      }),
    ).resolves.toMatchObject({ phase: "ready", oldEpoch: "43", replacementEpoch: "44" });
    expect(f.state().restartReservations.map((entry) => [entry.id, entry.phase])).toEqual([
      [second, "ready"],
    ]);
  });
});
