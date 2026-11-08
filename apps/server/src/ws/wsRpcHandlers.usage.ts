import { Effect, Schema } from "effect";
import {
  ServerGetUsageSummaryInput,
  ServerUsageError,
  type ServerUsageRange,
  type ServerUsageSummaryResult,
  WS_METHODS,
} from "@bigbud/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { usageProviderCoverage } from "../orchestration/usageAccountingSupport.ts";
import type { WsRpcContext } from "./wsRpcContext";
import { computeCurrentStreakDays } from "./wsRpcHandlers.usage.streak.ts";
import {
  prepareUsageAccounting,
  summarizeUsageAccounting,
} from "./wsRpcHandlers.usage.accounting.ts";
import { cachedUsageSummary, type UsageSummaryLookup } from "./wsRpcHandlers.usage.cache.ts";
import {
  tallyUsageBucketShare,
  type UsageBucketShareTally,
  usageBucketShares,
} from "./wsRpcHandlers.usage.bucketShares.ts";
import type { UsageSourceMetadata, UsageTokenMix } from "@bigbud/contracts/server/usage.ts";

type UsageAccumulator = {
  accounting?: UsageSourceMetadata;
  tokenMix?: UsageTokenMix;
  usedTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  turnCount: number;
};

type UsageEntry = UsageAccumulator & {
  accountingJson?: string | null;
  source?: "provider-reported" | "estimated";
  contributionId: string;
  threadId: string;
  turnId: string | null;
  turnKey: string;
  createdAt: string;
  createdAtMs: number;
  provider: string;
  model: string;
  interactionMode: string;
};

type UsageGroup = Omit<UsageAccumulator, "turnCount"> & {
  entries: UsageEntry[];
  turnKeys: Set<string>;
};

function toUsageError(cause: unknown, message: string) {
  return Schema.is(ServerUsageError)(cause)
    ? cause
    : new ServerUsageError({
        message,
        cause,
      });
}

function parseValidDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getRangeStart(range: ServerUsageRange, now: Date): Date | null {
  switch (range) {
    case "24h":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
  }
}

function getBucketStart(isoDate: string, range: ServerUsageRange) {
  const date = new Date(isoDate);
  if (range === "all") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
  } else if (range === "24h") {
    date.setUTCMinutes(0, 0, 0);
  } else {
    date.setUTCHours(0, 0, 0, 0);
  }
  return date.toISOString();
}

function emptyUsageGroup(): UsageGroup {
  return {
    usedTokens: 0,
    entries: [],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    turnKeys: new Set<string>(),
  };
}

function addUsage(target: UsageGroup, entry: UsageEntry) {
  target.entries.push(entry);
  target.usedTokens += entry.usedTokens;
  target.inputTokens += entry.inputTokens;
  target.cachedInputTokens += entry.cachedInputTokens;
  target.outputTokens += entry.outputTokens;
  target.reasoningOutputTokens += entry.reasoningOutputTokens;
  target.turnKeys.add(entry.turnKey);
}

function completeUsageGroup(group: UsageGroup, includeTokenMix = false): UsageAccumulator {
  const { accounting, tokenMix } = summarizeUsageAccounting(group.entries, includeTokenMix);
  return {
    accounting,
    ...(tokenMix ? { tokenMix } : {}),
    usedTokens: group.usedTokens,
    inputTokens: group.inputTokens,
    cachedInputTokens: group.cachedInputTokens,
    outputTokens: group.outputTokens,
    reasoningOutputTokens: group.reasoningOutputTokens,
    turnCount: group.turnKeys.size,
  };
}

function sortBreakdownEntries<T extends { usedTokens: number; label: string }>(entries: T[]) {
  return entries.toSorted(
    (left, right) => right.usedTokens - left.usedTokens || left.label.localeCompare(right.label),
  );
}

function buildUsageSummary(
  entries: ReadonlyArray<UsageEntry>,
  range: ServerUsageRange,
  historyStatus: ServerUsageSummaryResult["historyStatus"],
  streakDays: number,
  now: Date,
): ServerUsageSummaryResult {
  const totals = emptyUsageGroup();
  const bucketMap = new Map<string, UsageGroup>();
  const providerMap = new Map<string, UsageGroup>();
  const modelMap = new Map<string, UsageGroup>();
  const bucketProviders: UsageBucketShareTally = new Map();
  const bucketModels: UsageBucketShareTally = new Map();
  const modeMap = new Map<string, Set<string>>();

  for (const entry of entries) {
    addUsage(totals, entry);

    const bucketStart = getBucketStart(entry.createdAt, range);
    const bucket = bucketMap.get(bucketStart) ?? emptyUsageGroup();
    addUsage(bucket, entry);
    bucketMap.set(bucketStart, bucket);
    tallyUsageBucketShare(bucketProviders, bucketStart, entry.provider, entry.usedTokens);
    tallyUsageBucketShare(bucketModels, bucketStart, entry.model, entry.usedTokens);

    const provider = providerMap.get(entry.provider) ?? emptyUsageGroup();
    addUsage(provider, entry);
    providerMap.set(entry.provider, provider);

    const model = modelMap.get(entry.model) ?? emptyUsageGroup();
    addUsage(model, entry);
    modelMap.set(entry.model, model);

    const modeTurns = modeMap.get(entry.interactionMode) ?? new Set<string>();
    modeTurns.add(entry.turnKey);
    modeMap.set(entry.interactionMode, modeTurns);
  }

  const providers = sortBreakdownEntries(
    Array.from(providerMap.entries(), ([label, group]) => ({
      id: label,
      label: label === "unknown" ? "Unattributed usage" : label,
      ...completeUsageGroup(group),
    })),
  );
  const models = sortBreakdownEntries(
    Array.from(modelMap.entries(), ([label, group]) => ({
      id: label,
      label: label === "unknown" ? "Unattributed usage" : label,
      ...completeUsageGroup(group),
    })),
  );
  const buckets = Array.from(bucketMap.entries(), ([bucketStart, group]) => ({
    bucketStart,
    ...completeUsageGroup(group),
    providers: usageBucketShares(bucketProviders, bucketStart),
    models: usageBucketShares(bucketModels, bucketStart),
  })).toSorted((left, right) => left.bucketStart.localeCompare(right.bucketStart));

  const favoriteMode =
    Array.from(modeMap.entries()).toSorted(
      (left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? null;

  return {
    range,
    generatedAt: now.toISOString(),
    historyStatus,
    providerCoverage: usageProviderCoverage(),
    totals: completeUsageGroup(totals, true),
    buckets,
    providers,
    models,
    favoriteProvider: providers[0] ?? null,
    favoriteModel: models[0] ?? null,
    favoriteMode,
    streakDays,
  };
}

/** Reads only from `query`, so the shared cache never keeps a connection's context alive. */
const loadUsageSummary: UsageSummaryLookup = (query, range) =>
  Effect.gen(function* () {
    const now = new Date();
    const rangeStart = getRangeStart(range, now);
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    const [rows, historyStatus, activeDays] = yield* Effect.all([
      query.getUsageEntries(rangeStart?.toISOString() ?? null),
      query.getUsageHistoryStatus(),
      query.getUsageActiveDays(tomorrow.toISOString()),
    ]);
    const entries: UsageEntry[] = rows.flatMap((row) => {
      const createdAt = parseValidDate(row.createdAt);
      return createdAt
        ? [
            {
              ...prepareUsageAccounting(row),
              createdAt: createdAt.toISOString(),
              createdAtMs: createdAt.getTime(),
              turnKey: `${row.threadId}:${row.turnId ?? row.contributionId}`,
              turnCount: 1,
            },
          ]
        : [];
    });

    return buildUsageSummary(
      entries,
      range,
      historyStatus,
      computeCurrentStreakDays(activeDays, now),
      now,
    );
  }).pipe(Effect.mapError((cause) => toUsageError(cause, "Failed to load usage summary")));

export function makeWsRpcUsageHandlers(context: WsRpcContext) {
  const loadSummary = cachedUsageSummary(context.projectionSnapshotQuery, loadUsageSummary);
  return {
    [WS_METHODS.serverGetUsageSummary]: (input: typeof ServerGetUsageSummaryInput.Type) =>
      observeRpcEffect(WS_METHODS.serverGetUsageSummary, loadSummary(input.range), {
        "rpc.aggregate": "server",
      }),
  };
}
