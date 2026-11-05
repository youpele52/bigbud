import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { BackendInstanceShape } from "../startup/backendInstance.ts";
import {
  processAlive,
  processGroupAlive,
  signalProcess,
  signalProcessGroup,
} from "../utils/processGroup.ts";
import { makeProcessLedger, reapOrphanedProcesses } from "./Layers/ProcessLedger.ts";
import { killProcessLedgerTargets } from "./ProcessLedger.reap.ts";
import { readProcessTable, rowStartToken } from "./ProcessLedger.snapshot.ts";
import { parseProcessLedgerRecord } from "./ProcessLedger.record.ts";
import type { ProcessLedgerTrackInput } from "./Services/ProcessLedger.ts";

// The dummy "agent": a shell with a background grandchild, standing in for an agent's MCP servers.
const AGENT_SCRIPT = "sleep 60 & echo $!; wait";

const spawned: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.pid === undefined) continue;
    // Only this test's own dummies: detached ones by group, the rest one by one.
    if (child.spawnargs.includes("detached")) signalProcessGroup(child.pid, "SIGKILL");
    child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000) => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

/** Spawn the dummy agent; resolves once its grandchild PID is known. */
async function spawnDummy(detached: boolean) {
  // "detached" in argv only marks the dummy for afterEach cleanup; `sh -c` ignores it ($0).
  const child = spawn("sh", ["-c", AGENT_SCRIPT, detached ? "detached" : "attached"], {
    detached,
    stdio: ["ignore", "pipe", "ignore"],
  });
  spawned.push(child);
  const grandchildPid = await new Promise<number>((resolve) =>
    child.stdout!.once("data", (data: Buffer) => resolve(Number(data.toString().trim()))),
  );
  const input: ProcessLedgerTrackInput = {
    pid: child.pid!,
    command: "sh",
    args: ["-c", AGENT_SCRIPT, detached ? "detached" : "attached"],
    kill: detached ? "group" : "tree",
    label: "test-dummy",
  };
  return { child, grandchildPid, input };
}

function setup(owner: "dead" | "live" = "dead") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-process-ledger-"));
  dirs.push(dir);
  const deadOwner = {
    nonce: "dead-owner",
    pid: 999_999,
    startedAt: null,
    hostname: "h",
    machineId: null,
  };
  const recorder = makeProcessLedger({ dir, owner: deadOwner });
  const successor = {
    nonce: "successor",
    classifyOwner: () => owner,
    assertHeld: async () => {},
  } as unknown as BackendInstanceShape;
  const reap = () => Effect.runPromise(reapOrphanedProcesses(dir, successor));
  const records = () => fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  const track = (input: ProcessLedgerTrackInput) => Effect.runPromise(recorder.track(input));
  return { dir, reap, records, track };
}

describe.skipIf(process.platform === "win32")("process ledger with real processes", () => {
  it("reaps a dead owner's detached agent with its whole process group", async () => {
    const ledger = setup();
    const dummy = await spawnDummy(true);
    await ledger.track(dummy.input);
    expect(ledger.records()).toHaveLength(1);

    await ledger.reap();

    expect(await waitFor(() => !processGroupAlive(dummy.child.pid!))).toBe(true);
    expect(await waitFor(() => !processAlive(dummy.grandchildPid))).toBe(true);
    expect(ledger.records()).toHaveLength(0);
  });

  it("reaps a shared-group child by tree without signalling its group", async () => {
    const ledger = setup();
    // Not detached: the dummy shares the test runner's process group, as `kilo serve` shares the
    // desktop app's. A group kill would take this test process down with it.
    const dummy = await spawnDummy(false);
    await ledger.track(dummy.input);

    await ledger.reap();

    expect(await waitFor(() => !processAlive(dummy.child.pid!))).toBe(true);
    expect(await waitFor(() => !processAlive(dummy.grandchildPid))).toBe(true);
    expect(processAlive(process.pid)).toBe(true);
    expect(ledger.records()).toHaveLength(0);
  });

  it("never kills a child whose start token no longer matches (PID reuse)", async () => {
    const ledger = setup();
    const dummy = await spawnDummy(true);
    await ledger.track(dummy.input);
    const [name] = ledger.records();
    const file = path.join(ledger.dir, name!);
    const record = parseProcessLedgerRecord(fs.readFileSync(file, "utf8"))!;
    fs.writeFileSync(file, JSON.stringify({ ...record, startToken: `${record.startToken}0` }));

    await ledger.reap();

    expect(processGroupAlive(dummy.child.pid!)).toBe(true);
    expect(ledger.records()).toHaveLength(0);
  });

  it("never kills a child whose command line no longer matches", async () => {
    const ledger = setup();
    const dummy = await spawnDummy(true);
    await ledger.track({ ...dummy.input, args: ["--trust", "acp"] });

    await ledger.reap();

    expect(processGroupAlive(dummy.child.pid!)).toBe(true);
    expect(ledger.records()).toHaveLength(0);
  });

  it("leaves a live owner's children and records alone", async () => {
    const ledger = setup("live");
    const dummy = await spawnDummy(true);
    await ledger.track(dummy.input);

    await ledger.reap();

    expect(processGroupAlive(dummy.child.pid!)).toBe(true);
    expect(ledger.records()).toHaveLength(1);
  });

  it("drops a record on release only once the child is gone", async () => {
    const ledger = setup();
    const dummy = await spawnDummy(true);
    const ticket = await ledger.track(dummy.input);

    await Effect.runPromise(ticket.release);
    expect(ledger.records()).toHaveLength(1);

    signalProcessGroup(dummy.child.pid!, "SIGKILL");
    expect(await waitFor(() => !processGroupAlive(dummy.child.pid!))).toBe(true);
    await Effect.runPromise(ticket.release);
    expect(ledger.records()).toHaveLength(0);
  });

  // The shell and its grandchild both ignore SIGTERM, so only the re-proven SIGKILL ends them.
  for (const kill of ["tree", "group"] as const) {
    it(`SIGKILLs SIGTERM-ignoring ${kill} survivors only while their identity is re-proven`, async () => {
      const detached = kill === "group";
      const spawnStubborn = async () => {
        const label = detached ? "detached" : "attached";
        const child = spawn("sh", ["-c", `trap '' TERM; ${AGENT_SCRIPT}`, label], {
          detached,
          stdio: ["ignore", "pipe", "ignore"],
        });
        spawned.push(child);
        const grandchildPid = await new Promise<number>((resolve) =>
          child.stdout!.once("data", (data: Buffer) => resolve(Number(data.toString().trim()))),
        );
        const table = (await readProcessTable())!;
        const processes = [child.pid!, grandchildPid].map((pid) => ({
          pid,
          startToken: rowStartToken(table.get(pid)!)!,
        }));
        return { child, grandchildPid, targets: { kill, processes } };
      };

      // Re-proof fails (as if the PIDs were reused during the grace period): no SIGKILL at all.
      const spared = await spawnStubborn();
      const sparedResult = await Effect.runPromise(
        killProcessLedgerTargets([spared.targets], {
          grace: "200 millis",
          readTable: async () => new Map(),
        }),
      );
      expect(sparedResult).toEqual([false]);
      expect(processAlive(spared.child.pid!)).toBe(true);
      expect(processAlive(spared.grandchildPid)).toBe(true);
      // This test's own dummies, by the exact PIDs it spawned.
      for (const target of spared.targets.processes) signalProcess(target.pid, "SIGKILL");

      // Re-proof against the real table succeeds: each process gets SIGKILL.
      const killed = await spawnStubborn();
      const killedResult = await Effect.runPromise(
        killProcessLedgerTargets([killed.targets], { grace: "200 millis" }),
      );
      expect(killedResult).toEqual([true]);
      // Orphaned by the kill, it may linger as a zombie until init reaps it.
      expect(await waitFor(() => !processAlive(killed.grandchildPid))).toBe(true);
    });
  }
});
