import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { ModelRef, PermissionRuleset, SessionInfo } from "@opencode/client";
import type { OpencodeV2SharedBinding } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import type { V2IsolatedRuntimeOptions, V2StartInput } from "./Runtime.types.ts";
import type { resolveV2RuntimeBinding } from "./Runtime.binding.ts";
import { v2Request } from "./Client.ts";
import { V2HttpStatusError } from "./Client.errors.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { decodeV2NativeSession } from "./Runtime.session.decode.ts";

/** Reserve before mutation, adopt only exact API history, and retain lost-ack intents indefinitely. */
export async function prepareSharedCreation(
  options: V2IsolatedRuntimeOptions,
  input: V2StartInput,
  binding: Awaited<ReturnType<typeof resolveV2RuntimeBinding>>,
  model: ModelRef,
  permissions: PermissionRuleset,
) {
  const repo = options.sharedBindings;
  if (!repo) throw new Error("V2 shared binding repository unavailable.");
  const existing = await Effect.runPromise(repo.find(input.threadId));
  currentV2RequestContext()?.permit.assertCurrent();
  const retained = await Effect.runPromise(options.journal.latestBound(input.threadId));
  currentV2RequestContext()?.permit.assertCurrent();
  const legacy =
    existing?.identityKind === "adopted-legacy-v1" ||
    input.resumeCursor !== undefined ||
    retained !== undefined;
  const material =
    existing?.state === "verified"
      ? existing.material
      : createHash("sha256")
          .update(
            JSON.stringify({
              model,
              runtimeMode: input.runtimeMode,
              localTools: options.enableLocalTools === true,
            }),
          )
          .digest("hex");
  const row = await Effect.runPromise(
    repo.reserve({
      threadId: input.threadId,
      nativeSessionId: binding.nativeSessionId,
      storageIdentity: binding.storageIdentity,
      directory: binding.directory,
      runtimeTargetId: binding.runtimeTarget,
      workspaceTargetId: binding.workspaceTarget,
      identityKind:
        existing?.identityKind ??
        (legacy
          ? "adopted-legacy-v1"
          : binding.registrationFamily === "scoped"
            ? "shared-api-v2"
            : "shared-api-v1"),
      ...(binding.registrationFamily === "scoped"
        ? { profileIssuer: binding.profileIssuer!, registrationFamily: "scoped" as const }
        : {}),
      material,
    }),
  );
  currentV2RequestContext()?.permit.assertCurrent();
  return {
    row,
    retained: Boolean(existing || legacy),
    canCreate: !legacy && row.state === "reserved",
    dispatch: async () => {
      if (legacy || row.state !== "reserved")
        throw new Error("V2 shared creation is unconfirmed; never resend.");
      currentV2RequestContext()?.permit.assertCurrent();
      const intent = await Effect.runPromise(repo.transition(row, "dispatch-intent"));
      currentV2RequestContext()?.permit.assertCurrent();
      return intent;
    },
    verify: async (current: OpencodeV2SharedBinding) => {
      currentV2RequestContext()?.permit.assertCurrent();
      if (current.state !== "verified")
        await Effect.runPromise(repo.transition(current, "verified"));
      currentV2RequestContext()?.permit.assertCurrent();
    },
    permissions,
  };
}

/** Exact lookup only. Missing history is distinct from an unavailable/invalid response. */
export async function findSharedSession(
  client: import("./Client.ts").OpencodeV2Client,
  id: string,
  signal?: AbortSignal,
): Promise<SessionInfo | undefined> {
  try {
    return decodeV2NativeSession(
      await v2Request(
        "shared session.get",
        (requestSignal) => client.session.get({ sessionID: id }, { signal: requestSignal }),
        signal ? { signal } : {},
      ),
    );
  } catch (error) {
    if (error instanceof V2HttpStatusError && error.status === 404) return undefined;
    throw error;
  }
}

/** Preserve historical permission order/material when it is at least as restrictive. */
export function conservedSharedPolicy(
  actual: PermissionRuleset | undefined,
  required: PermissionRuleset,
): PermissionRuleset {
  if (!actual || actual.length > 256) throw new Error("V2 legacy policy is absent or unbounded.");
  const base = required.filter((rule) => rule.effect !== "deny");
  const actualBase = actual.filter((rule) => rule.effect !== "deny");
  if (
    JSON.stringify(base) !== JSON.stringify(actualBase) ||
    JSON.stringify(actual.slice(0, base.length)) !== JSON.stringify(base)
  )
    throw new Error("V2 legacy policy grants conflict; no migration mutation.");
  for (const rule of actual) {
    if (
      !["allow", "ask", "deny"].includes(rule.effect) ||
      typeof rule.action !== "string" ||
      typeof rule.resource !== "string" ||
      !rule.action.length ||
      !rule.resource.length ||
      rule.action.length > 128 ||
      rule.resource.length > 4096 ||
      [...rule.action, ...rule.resource].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error("V2 legacy policy grammar rejected.");
  }
  for (const rule of required.filter((entry) => entry.effect === "deny")) {
    if (
      !actual.some(
        (old) =>
          old.effect === "deny" &&
          old.action === rule.action &&
          (old.resource === rule.resource ||
            old.resource === "*" ||
            (old.resource.endsWith("/**") && rule.resource.startsWith(old.resource.slice(0, -2)))),
      )
    )
      throw new Error("V2 legacy policy lacks mandatory known-path protection.");
  }
  return actual;
}
