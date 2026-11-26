import { Struct } from "effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { TerminalOpenInput, TerminalSessionSnapshot } from "./terminal";
import {
  TerminalEventsSubscriptionInput,
  TerminalSessionInventory,
  TerminalSessionStreamInput,
} from "./terminal.stream";

/** The RPC server decodes payloads exactly like this (`RpcServer` uses `toCodecJson`). */
const decodeAsRpcPeer = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema as never) as never) as (
    input: unknown,
  ) => Record<string, unknown>;

// Today's schemas without the lifecycle fields: what an older server or client still runs.
const LegacyOpenInput = TerminalOpenInput.mapFields(Struct.omit(["attachOnly", "evict"]));
const LegacySessionStreamInput = TerminalSessionStreamInput.mapFields(
  Struct.omit(["acceptScreen"]),
);
const LegacyEventsSubscriptionInput = TerminalEventsSubscriptionInput.mapFields(
  Struct.omit(["includeLifecycle"]),
);
const LegacySnapshot = TerminalSessionSnapshot.mapFields(
  Struct.omit(["screenSource", "restorable", "endedReason"]),
);
const LegacyInventory = Schema.Struct({
  type: Schema.Literal("inventory"),
  createdAt: Schema.String,
  sessions: Schema.Array(Schema.Struct({ threadId: Schema.String, terminalId: Schema.String })),
});

describe("Effect Schema.Struct ignores excess keys between versions", () => {
  it("lets an older server accept and drop the new open fields", () => {
    const payload = {
      threadId: "thread",
      terminalId: "pane",
      cwd: "/repo",
      attachOnly: true,
      evict: { threadId: "old", terminalId: "pane-9" },
    };
    const decoded = decodeAsRpcPeer(LegacyOpenInput)(payload);
    expect(decoded).toEqual({ threadId: "thread", terminalId: "pane", cwd: "/repo" });
    expect(decoded).not.toHaveProperty("attachOnly");
    expect(decoded).not.toHaveProperty("evict");
  });

  it("lets an older server accept and drop the stream opt-ins", () => {
    expect(
      decodeAsRpcPeer(LegacySessionStreamInput)({
        threadId: "thread",
        terminalId: "pane",
        acceptScreen: true,
      }),
    ).toEqual({ threadId: "thread", terminalId: "pane" });
    expect(
      decodeAsRpcPeer(LegacyEventsSubscriptionInput)({
        includeInventory: true,
        includeLifecycle: true,
      }),
    ).toEqual({ includeInventory: true });
  });

  it("lets an older client accept and drop the new snapshot and inventory fields", () => {
    const snapshot = {
      threadId: "thread",
      terminalId: "pane",
      dropPathMode: "posix",
      cwd: "/repo",
      worktreePath: null,
      status: "running",
      pid: 42,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-11-21T10:00:00.000Z",
      screenSource: "host",
      restorable: true,
      endedReason: "idle",
    };
    const decoded = decodeAsRpcPeer(LegacySnapshot)(snapshot);
    expect(decoded).not.toHaveProperty("screenSource");
    expect(decoded).not.toHaveProperty("restorable");
    expect(decoded).not.toHaveProperty("endedReason");
    expect(decoded).toMatchObject({ threadId: "thread", status: "running", pid: 42 });
    expect(
      decodeAsRpcPeer(LegacyInventory)({
        type: "inventory",
        createdAt: "2026-11-21T10:00:00.000Z",
        sessions: [{ threadId: "a", terminalId: "1", activity: "busy", restorable: false }],
      }),
    ).toEqual({
      type: "inventory",
      createdAt: "2026-11-21T10:00:00.000Z",
      sessions: [{ threadId: "a", terminalId: "1" }],
    });
  });

  it("lets a newer peer accept payloads from an older one unchanged", () => {
    expect(
      decodeAsRpcPeer(TerminalOpenInput)({ threadId: "thread", terminalId: "pane", cwd: "/repo" }),
    ).toEqual({ threadId: "thread", terminalId: "pane", cwd: "/repo" });
    expect(
      decodeAsRpcPeer(TerminalSessionInventory)({
        type: "inventory",
        createdAt: "2026-11-21T10:00:00.000Z",
        sessions: [{ threadId: "a", terminalId: "1" }],
      }),
    ).toMatchObject({ sessions: [{ threadId: "a", terminalId: "1" }] });
  });
});
