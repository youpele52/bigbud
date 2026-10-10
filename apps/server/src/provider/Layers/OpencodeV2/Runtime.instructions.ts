import { createHash } from "node:crypto";
import type { InstructionEntryInfo } from "@opencode/client";
import { buildOpencodeSystemPrompt } from "../Opencode/Adapter.session.turn.systemPrompt.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { v2Request } from "./Client.ts";
import { V2_LOCAL_TOOL_LIMITATION } from "./Runtime.policy.ts";

const OWNED_KEYS = [
  "bigbud.preview.v1.access",
  "bigbud.preview.v1.workspace",
  "bigbud.preview.v1.browser",
];

/** Shared orchestration/learning content is already assembled into input; only provider-owned context goes here. */
export function v2InstructionEntries(session: V2RuntimeSession): InstructionEntryInfo[] {
  if (!session.localTools) return [];
  return [
    {
      key: OWNED_KEYS[0]!,
      value:
        session.lease.process.ownership === "borrowed"
          ? `Selected bigbud access mode: ${session.session.runtimeMode}. Native tools, agents, skills and configured MCP use the shared OpenCode service with ordinary host-user authority, not a sandbox. Approval-required asks before native actions; Auto accept edits allows native edits and asks for other actions; Full access trusts native tools. External directories still require approval. Never modify native account/config/service storage. Canonical bigbud child-thread tools are not injected into this service.`
          : `Selected bigbud access mode: ${session.session.runtimeMode}. ${V2_LOCAL_TOOL_LIMITATION}`,
    },
    ...(session.resources?.codingFiles
      ? [
          {
            key: OWNED_KEYS[1]!,
            value: {
              workspaceTargetId: session.session.workspaceExecutionTargetId ?? "local",
              root: session.resources.codingFiles.root,
              guidance:
                "Use target-bound bigbud broker tools for this workspace. The native Location is not a local-path fallback for remote files.",
            },
          },
        ]
      : []),
    ...(session.resources?.orchestration
      ? [{ key: OWNED_KEYS[2]!, value: buildOpencodeSystemPrompt() }]
      : []),
  ];
}

/** Versioned revision participates in immutable admission fingerprints; absent revisions preserve historical fingerprints. */
export function v2InstructionRevision(
  entries: readonly InstructionEntryInfo[],
): string | undefined {
  return entries.length
    ? createHash("sha256").update(JSON.stringify(entries)).digest("hex")
    : undefined;
}

/** Serialized, read-back verified changes affect only exact bigbud-owned keys, never native/user entries. */
export async function syncV2Instructions(
  session: V2RuntimeSession,
  mutations: V2RuntimeMutations,
  entries: InstructionEntryInfo[],
  beforeDispatch: () => Promise<() => void>,
) {
  const client = session.lease.process.client;
  const read = () =>
    v2Request("instructions.entry.list", (signal) =>
      client.session.instructions.entry.list({ sessionID: session.native.id }, { signal }),
    );
  await mutations.withNamespace(async () => {
    const current = await read();
    if (current.length > 128) throw new Error("V2 instruction inventory exceeds bound.");
    for (const key of OWNED_KEYS) {
      const wanted = entries.find((entry) => entry.key === key);
      const existing = current.find((entry) => entry.key === key);
      if (JSON.stringify(wanted?.value) === JSON.stringify(existing?.value)) continue;
      const validate = await beforeDispatch();
      if (session.stopped || !session.lease.process.isRunning())
        throw new Error("V2 instruction owner lost.");
      await mutations.runOwned(
        session.lease.process,
        "instructions.entry.sync",
        (signal) =>
          wanted
            ? client.session.instructions.entry.put(
                { sessionID: session.native.id, key, value: wanted.value },
                { signal },
              )
            : client.session.instructions.entry.remove(
                { sessionID: session.native.id, key },
                { signal },
              ),
        async () => {
          validate();
          const verified = await read();
          validate();
          return (
            JSON.stringify(verified.find((entry) => entry.key === key)?.value) ===
            JSON.stringify(wanted?.value)
          );
        },
        10000,
        undefined,
        true,
        validate,
      );
    }
  });
}
