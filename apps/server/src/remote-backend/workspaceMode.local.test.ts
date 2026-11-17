import { chmodSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { convertWorkspaceMode } from "./workspaceMode.conversion.ts";
import {
  decodeWorkspaceModeRecord,
  encodeWorkspaceModeRecord,
  workspaceModeKey,
} from "./workspaceMode.record.ts";
import { reserveWorkspaceMode } from "./workspaceMode.reserve.ts";
import { makeWorkspaceModeFixture, OWNER_A, OWNER_B } from "./workspaceMode.test.helpers.ts";

describe.runIf(process.platform !== "win32")("workspace mode local store", () => {
  let f: ReturnType<typeof makeWorkspaceModeFixture> | undefined;
  afterEach(() => {
    f?.close();
    f = undefined;
  });

  it("symlink_alias_maps_to_same_reservation", async () => {
    f = makeWorkspaceModeFixture();
    const alias = path.join(f.base, "alias");
    symlinkSync(f.workspace, alias);
    const viaReal = await reserveWorkspaceMode(
      f.localStore,
      f.workspace,
      "remote-runtime",
      OWNER_A,
    );
    const viaAlias = await reserveWorkspaceMode(
      f.localStore,
      `${alias}/./`,
      "laptop-runtime",
      OWNER_B,
    );
    expect(viaReal.kind).toBe("reserved");
    expect(viaAlias).toMatchObject({
      kind: "conflict",
      holder: { mode: "remote-runtime", owner: OWNER_A },
    });
    expect(readdirSync(f.modesDir)).toHaveLength(1);
  });

  it("creates private directories and 0600 generation files", async () => {
    f = makeWorkspaceModeFixture();
    const outcome = await reserveWorkspaceMode(
      f.localStore,
      f.workspace,
      "remote-runtime",
      OWNER_A,
    );
    if (outcome.kind !== "reserved") throw new Error("expected a reservation");
    const dir = path.join(f.modesDir, workspaceModeKey(outcome.record));
    expect(readdirSync(dir)).toEqual(["1.json"]);
    // Same mode, other owner: shared, not republished.
    expect(
      await reserveWorkspaceMode(f.localStore, f.workspace, "remote-runtime", OWNER_B),
    ).toMatchObject({
      kind: "reserved",
      record: { generation: 1, owner: OWNER_A },
    });
  });

  it("refuses symlinked or public reservation storage", async () => {
    f = makeWorkspaceModeFixture();
    await reserveWorkspaceMode(f.localStore, f.workspace, "remote-runtime", OWNER_A);
    chmodSync(f.modesDir, 0o755);
    await expect(f.localStore.inspect(f.workspace)).rejects.toThrow("private directory (0700)");
    chmodSync(f.modesDir, 0o700);
    const [key] = readdirSync(f.modesDir);
    const file = path.join(f.modesDir, key!, "1.json");
    chmodSync(file, 0o644);
    await expect(f.localStore.inspect(f.workspace)).rejects.toThrow("private file (0600)");
  });

  it("rejects non-canonical records", () => {
    const record = {
      generation: 1,
      hostIdentity: `machine-v1:${"c".repeat(64)}`,
      accountUid: 501,
      realpathSha256: "d".repeat(64),
      mode: "laptop-runtime" as const,
      owner: null,
    };
    const raw = encodeWorkspaceModeRecord(record);
    expect(decodeWorkspaceModeRecord(raw)).toEqual(record);
    expect(() => decodeWorkspaceModeRecord(` ${raw}`)).toThrow();
    expect(() => decodeWorkspaceModeRecord(raw.replace('"laptop-runtime"', '"both"'))).toThrow();
  });

  it("concurrent_conversion_one_wins", async () => {
    f = makeWorkspaceModeFixture();
    await reserveWorkspaceMode(f.localStore, f.workspace, "laptop-runtime", OWNER_A);
    const convert = () =>
      convertWorkspaceMode({
        store: f!.localStore,
        workspaceRoot: f!.workspace,
        requesterMode: "laptop-runtime",
        targetMode: "remote-runtime",
        isBusy: async () => ({ busy: false }),
      });
    const outcomes = await Promise.all([convert(), convert(), convert(), convert()]);
    expect(outcomes.filter((outcome) => outcome.kind === "converted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "refused")).toHaveLength(3);
    const after = await f.localStore.inspect(f.workspace);
    expect(after).toMatchObject({
      current: { generation: 2, mode: "remote-runtime", owner: null },
    });
    // The first backend of the new mode claims the unowned record.
    expect(
      await reserveWorkspaceMode(f.localStore, f.workspace, "remote-runtime", OWNER_B),
    ).toMatchObject({
      record: { generation: 3, owner: OWNER_B },
    });
  });

  it("convert_refused_while_busy", async () => {
    f = makeWorkspaceModeFixture();
    await reserveWorkspaceMode(f.localStore, f.workspace, "laptop-runtime", OWNER_A);
    const outcome = await convertWorkspaceMode({
      store: f.localStore,
      workspaceRoot: f.workspace,
      requesterMode: "laptop-runtime",
      targetMode: "remote-runtime",
      isBusy: async () => ({ busy: true, reason: "thread 't1' has an open terminal." }),
    });
    expect(outcome).toEqual({
      kind: "refused",
      reason: expect.stringContaining("idle: thread 't1' has an open terminal."),
    });
    expect(await f.localStore.inspect(f.workspace)).toMatchObject({
      current: { generation: 1, mode: "laptop-runtime" },
    });
  });

  it("refuses conversion from a backend that does not hold the mode", async () => {
    f = makeWorkspaceModeFixture();
    await reserveWorkspaceMode(f.localStore, f.workspace, "laptop-runtime", OWNER_A);
    const outcome = await convertWorkspaceMode({
      store: f.localStore,
      workspaceRoot: f.workspace,
      requesterMode: "remote-runtime",
      targetMode: "remote-runtime",
      isBusy: async () => ({ busy: false }),
    });
    expect(outcome).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("Only the backend"),
    });
  });

  it("ignores stray temp files and reads the newest generation", async () => {
    f = makeWorkspaceModeFixture();
    const first = await reserveWorkspaceMode(f.localStore, f.workspace, "laptop-runtime", OWNER_A);
    if (first.kind !== "reserved") throw new Error("expected a reservation");
    writeFileSync(path.join(f.modesDir, workspaceModeKey(first.record), ".tmp.left"), "x", {
      mode: 0o600,
    });
    expect(await f.localStore.inspect(f.workspace)).toMatchObject({ current: { generation: 1 } });
  });
});
