import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { prepareResourceContext } from "./ProviderCommandReactorSessionOps.resourceContext.ts";
import type { SystemResourcesResult } from "../../orchestration-tools/ThreadSystemResourcesTool.ts";
import { sendTurnForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  createdAt,
  makeSettingsHarness,
  threadId,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";

const unavailable = { available: false, reason: "desktop monitor unavailable" } as const;
const metric = (value: number) => ({ value, status: "ready", sampledAtMs: 10000 });
afterEach(() => {
  vi.unstubAllEnvs();
});

it("bounds initial context, skips unchanged telemetry and refreshes on context/health/age changes", () => {
  const first = prepareResourceContext(unavailable, undefined, "session1", 1000);
  expect(first.block).toContain("desktop_resource_context");
  expect(first.block).toContain("unavailable");
  expect(prepareResourceContext(unavailable, first.next, "session1", 2000).block).toBe("");
  expect(prepareResourceContext(unavailable, first.next, "session2", 2000).block).not.toBe("");
  expect(prepareResourceContext(unavailable, first.next, "session1", 62000).block).not.toBe("");
  expect(
    prepareResourceContext(
      { available: false, reason: "monitoring disabled" },
      first.next,
      "session1",
      2000,
    ).block,
  ).toContain("disabled");
});

it("includes only bounded selected telemetry, detects 10pp changes and excludes process names", () => {
  const result = {
    available: true,
    sampledAtMs: 10000,
    cpuPercent: metric(10),
    memoryTotalBytes: metric(100),
    memoryUsedBytes: metric(20),
    health: "healthy",
    processes: [{ name: "SECRET_PROCESS" }],
    appResources: { groups: "🔥".repeat(5000) },
    alerts: [],
  } as unknown as SystemResourcesResult;
  const first = prepareResourceContext(result, undefined, "main", 10000);
  expect(first.next).toMatchObject({ deliveredAtMs: 10000, cpu: 10, memory: 20 });
  expect(Buffer.byteLength(first.block)).toBeLessThanOrEqual(4096);
  expect(first.block).not.toContain("SECRET_PROCESS");
  expect(
    prepareResourceContext(
      { ...result, cpuPercent: metric(19) } as SystemResourcesResult,
      first.next,
      "main",
      10000,
    ).block,
  ).toBe("");
  expect(
    prepareResourceContext(
      { ...result, cpuPercent: metric(20) } as SystemResourcesResult,
      first.next,
      "main",
      10000,
    ).block,
  ).not.toBe("");
  expect(
    prepareResourceContext(
      { ...result, ruleRevision: 2 } as SystemResourcesResult,
      first.next,
      "main",
      10000,
    ).block,
  ).not.toBe("");
});

it.each([
  [8000, 10, 20],
  [7999, undefined, undefined],
  [15000, 10, 20],
  [15001, undefined, undefined],
])(
  "evaluates metric freshness at supplied time %i without changing the clock",
  (now, cpu, memory) => {
    const result = {
      available: true,
      cpuPercent: metric(10),
      memoryTotalBytes: metric(100),
      memoryUsedBytes: metric(20),
    } as unknown as SystemResourcesResult;
    const { next } = prepareResourceContext(result, undefined, "main", now);
    expect(next.deliveredAtMs).toBe(now);
    expect(next.cpu).toBe(cpu);
    expect(next.memory).toBe(memory);
  },
);

it.each(["core", "inclusive", "tools"])(
  "detects bounded app %s deltas without host changes",
  (role) => {
    const result = (cpu: number, bytes: number) =>
      ({
        available: true,
        cpuPercent: metric(30),
        memoryTotalBytes: metric(64 * 1024 ** 3),
        memoryUsedBytes: metric(32 * 1024 ** 3),
        appResources:
          role === "tools"
            ? { groups: [{ role, cpuPercent: metric(cpu), residentBytes: metric(bytes) }] }
            : { [role]: { cpuPercent: metric(cpu), residentBytes: metric(bytes) } },
      }) as unknown as SystemResourcesResult;
    const first = prepareResourceContext(result(1, 1024 ** 3), undefined, "main", 10000);
    expect(
      prepareResourceContext(result(2, 1024 ** 3 + 1024), first.next, "main", 10000).block,
    ).toBe("");
    for (const changed of [result(29, 1024 ** 3), result(1, 30 * 1024 ** 3)]) {
      const update = prepareResourceContext(changed, first.next, "main", 10000);
      expect(update.block).not.toBe("");
      expect(Buffer.byteLength(update.block)).toBeLessThanOrEqual(4096);
    }
  },
);

it.each([
  "cpuPercent",
  "memoryUsedBytes",
  "memoryTotalBytes",
  "memoryAvailableBytes",
  "swapUsedBytes",
  "app",
])("detects %s availability and freshness transitions in both directions", (key) => {
  const result = (status = "ready", sampledAtMs = 10000) => {
    const value = { value: 30, status, sampledAtMs };
    return {
      available: true,
      ...(key === "app" ? { appResources: { core: { cpuPercent: value } } } : { [key]: value }),
    } as unknown as SystemResourcesResult;
  };
  const first = prepareResourceContext(result(), undefined, "main", 10000);
  for (const changed of [result("unavailable"), result("ready", 4999)]) {
    const update = prepareResourceContext(changed, first.next, "main", 10000);
    expect(update.block).not.toBe("");
    if (key === "cpuPercent") expect(update.next.cpu).toBeUndefined();
    expect(prepareResourceContext(result(), update.next, "main", 10000).block).not.toBe("");
  }
  const expired = prepareResourceContext(result(), first.next, "main", 15001);
  expect(expired.block).not.toBe("");
  expect(
    prepareResourceContext(result("ready", 15001), expired.next, "main", 15001).block,
  ).not.toBe("");
});

it("does not commit initial telemetry on a failed dispatch; commits only after acceptance", async () => {
  const harness = makeSettingsHarness();
  harness.sendTurn.mockImplementationOnce(() =>
    Effect.fail(new ProviderValidationError({ operation: "sendTurn", issue: "invalid request" })),
  );
  const input = { threadId, createdAt, messageText: "Check resources" };
  await expect(Effect.runPromise(sendTurnForThread(harness.services)(input))).rejects.toThrow();
  expect(harness.services.capabilityContextStates.get(threadId)?.resourceContext).toBeUndefined();
  await Effect.runPromise(sendTurnForThread(harness.services)(input));
  expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("desktop_resource_context");
  expect(harness.services.capabilityContextStates.get(threadId)?.resourceContext).toBeDefined();
  harness.settle();
  await Effect.runPromise(
    sendTurnForThread(harness.services)({ ...input, messageText: "Continue" }),
  );
  expect(harness.sendTurn.mock.calls[2]?.[0].input).not.toContain("desktop_resource_context");
});

it("uses the newly established session epoch and remains independent of the capability-context flag", async () => {
  vi.stubEnv("BIGBUD_CAPABILITY_CONTEXT_ENABLED", "false");
  const harness = makeSettingsHarness();
  const input = { threadId, createdAt, messageText: "Initial prompt" };
  await Effect.runPromise(sendTurnForThread(harness.services)(input));
  expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain("desktop_resource_context");
  expect(harness.sendTurn.mock.calls[0]?.[0].input).not.toContain("bigbud_capability_lp");
  harness.settle();
  await Effect.runPromise(
    sendTurnForThread(harness.services)({ ...input, messageText: "Continue" }),
  );
  expect(harness.sendTurn.mock.calls[1]?.[0].input).not.toContain("desktop_resource_context");
});
