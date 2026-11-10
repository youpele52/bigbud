import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCodexThreadOrchestrationDynamicTools } from "../../../orchestration-tools/codexThreadDynamicTools.specs.ts";
import {
  FROZEN_V1_GET_THREAD_STATUS_TOOL_DESCRIPTION,
  FROZEN_V1_RENAME_THREAD_TOOL_DESCRIPTION,
  FROZEN_V1_SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
} from "../../../orchestration-tools/threadOrchestrationBridge.shared.ts";
import { FROZEN_V1_TARGET_THREAD_ID_DESCRIPTION } from "../../../orchestration-tools/threadRenameTool.shared.ts";
import { V2_NATIVE_BOOTSTRAP_SPECS } from "./Orchestration.plugin.specs.ts";
import { canonicalV2ThreadRequest, type V2ThreadInvocation } from "./Orchestration.callback.ts";
import {
  V2ThreadImplementationRegistry,
  v2ThreadImplementation,
} from "./Orchestration.implementation.ts";

/**
 * Live descriptions moved on (cross-project confirmation guidance) while the bootstrap ABI stays
 * frozen. Only these explicitly frozen v1 copies may differ; every other byte must still match.
 */
const FROZEN_V1_DESCRIPTIONS: Readonly<Record<string, string>> = {
  rename_thread: FROZEN_V1_RENAME_THREAD_TOOL_DESCRIPTION,
  get_thread_status: FROZEN_V1_GET_THREAD_STATUS_TOOL_DESCRIPTION,
  send_thread_message: FROZEN_V1_SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
};
const withFrozenV1TargetThreadId = (name: string, input: unknown) => {
  if (name !== "rename_thread") return input;
  const schema = input as { properties: { targetThreadId: object } };
  return {
    ...schema,
    properties: {
      ...schema.properties,
      targetThreadId: {
        ...schema.properties.targetThreadId,
        description: FROZEN_V1_TARGET_THREAD_ID_DESCRIPTION,
      },
    },
  };
};

it("frozen bootstrap schemas match current five supported public operations without live imports at rendering", () => {
  const live = createCodexThreadOrchestrationDynamicTools()
    .filter((tool) => V2_NATIVE_BOOTSTRAP_SPECS.some((spec) => spec.action === tool.name))
    .map(({ name, description, inputSchema }) => ({
      name: `bigbud_thread_v1_${name}`,
      action: name,
      description: FROZEN_V1_DESCRIPTIONS[name] ?? description,
      input: withFrozenV1TargetThreadId(name, inputSchema),
    }));
  expect(V2_NATIVE_BOOTSTRAP_SPECS).toEqual(live);
  // The allowance is exactly the frozen copies: the live text really differs from them.
  for (const [name, frozen] of Object.entries(FROZEN_V1_DESCRIPTIONS)) {
    const tool = createCodexThreadOrchestrationDynamicTools().find((entry) => entry.name === name);
    expect(tool?.description).not.toBe(frozen);
  }
});

it("A frozen preparation preserves legacy canonical bodies and B has genuinely different normalization/interpretation", () => {
  const a = v2ThreadImplementation("v1"),
    b = v2ThreadImplementation("v2");
  for (const [action, input] of [
    ["create_thread", { title: " t ", task: " task ", watchForCompletion: true }],
    ["send_thread_message", { threadId: "target", message: " text ", delivery: "queue" }],
    ["get_thread_status", { threadId: "target" }],
    ["list_threads", {}],
    ["rename_thread", { title: "renamed", targetThreadId: "target" }],
  ] as const) {
    expect(a.prepare({ action, input, callerThreadId: "caller" })).toEqual(
      canonicalV2ThreadRequest({ action, input } as V2ThreadInvocation, "caller"),
    );
  }
  expect(a.prepare({ action: "list_threads", input: {}, callerThreadId: "caller" })).toEqual({
    action: "list_threads",
  });
  expect(b.prepare({ action: "list_threads", input: {}, callerThreadId: "caller" })).toEqual({
    action: "list_threads",
    limit: 1,
  });
  expect(a.interpret({ action: "list_threads", canonicalResult: { ok: true } })).toEqual({
    ok: true,
  });
  expect(b.interpret({ action: "list_threads", canonicalResult: { ok: true } })).toEqual({
    result: { ok: true },
    implementation: "bounded-list-v2",
  });
  expect(a.implementationDigest).not.toBe(b.implementationDigest);
  expect(a.bootstrapAbi).toBe(b.bootstrapAbi);
  expect(a.schemaDigest).toBe(b.schemaDigest);
});

it("default switching/rollback never alters captured handler references and source manifest drift verification runs", () => {
  const registry = new V2ThreadImplementationRegistry();
  const a = registry.acquire();
  registry.select("v2");
  const b = registry.acquire();
  registry.select("v1");
  expect(a.handler).toBe(v2ThreadImplementation("v3"));
  expect(b.handler).toBe(v2ThreadImplementation("v2"));
  a.release();
  a.release();
  b.release();
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../../scripts/generateThreadToolImplementationManifest.ts", import.meta.url),
      ),
      "--check",
    ],
    { cwd: fileURLToPath(new URL("../../../../../..", import.meta.url)), stdio: "pipe" },
  );
});

it("bounded generation references are not evicted, and forged/unbundled code references are rejected", () => {
  const registry = new V2ThreadImplementationRegistry(1);
  const a = registry.acquire();
  registry.select("v2");
  expect(() => registry.acquire()).toThrow("capacity is full");
  expect(() => registry.acquire({ ...a.handler })).toThrow("unbundled");
  a.release();
  const b = registry.acquire();
  expect(b.handler).toBe(v2ThreadImplementation("v2"));
  b.release();
});
